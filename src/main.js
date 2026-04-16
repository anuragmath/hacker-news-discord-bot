import { Client, EmbedBuilder } from 'discord.js';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

// Fix #5: validate env vars at startup
const { BOT_TOKEN, SHOW_CHANNEL_ID, JOB_CHANNEL_ID, NEWS_CHANNEL_ID } = process.env;
for (const [key, val] of Object.entries({ BOT_TOKEN, SHOW_CHANNEL_ID, JOB_CHANNEL_ID, NEWS_CHANNEL_ID })) {
    if (!val) { console.error(`Missing required env var: ${key}`); process.exit(1); }
}

// Fix #3: resolve path relative to this file, not CWD
const __dirname = dirname(fileURLToPath(import.meta.url));
const POSTED_IDS_FILE = join(__dirname, '..', 'posted.json');

const MAX_POSTED_IDS = 10_000;
const FETCH_RETRIES = 3;
const RETRY_DELAY = 1000;
const REQUEST_DELAY = 100;
const POLL_INTERVAL = 5_000;
const CLEANUP_INTERVAL = 6 * 60 * 60 * 1000; // run every 6 hours
const MESSAGE_MAX_AGE_DAYS = parseInt(process.env.MESSAGE_MAX_AGE_DAYS ?? '3', 10);
const BULK_DELETE_LIMIT_MS = 14 * 24 * 60 * 60 * 1000; // Discord won't bulk-delete messages older than 14 days

const client = new Client({ intents: [] });
let postedIds = new Set();
let BOT_START_TIME = 0;
let LAST_MAX_ITEM = 0;
let saveScheduled = false;

async function loadPostedIds() {
    try {
        const data = await readFile(POSTED_IDS_FILE, 'utf8');
        postedIds = new Set(JSON.parse(data));
    } catch (err) {
        if (err.code === 'ENOENT') await writeFile(POSTED_IDS_FILE, '[]');
        else console.error('Error loading posted IDs:', err);
    }
}

// Fix #8: batch saves via setImmediate instead of writing after every post
function scheduleSave() {
    if (saveScheduled) return;
    saveScheduled = true;
    setImmediate(async () => {
        saveScheduled = false;
        await savePostedIds();
    });
}

async function savePostedIds() {
    // Fix #7: trim to the most recent MAX_POSTED_IDS entries
    const ids = [...postedIds];
    if (ids.length > MAX_POSTED_IDS) {
        postedIds = new Set(ids.slice(-MAX_POSTED_IDS));
    }
    await writeFile(POSTED_IDS_FILE, JSON.stringify([...postedIds]));
}

async function fetchItemWithRetry(id, retries = FETCH_RETRIES) {
    try {
        const res = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data || typeof data !== 'object' || !data.id) throw new Error('Invalid item format');
        return data;
    } catch (err) {
        if (retries > 0) {
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            return fetchItemWithRetry(id, retries - 1);
        }
        console.error(`Failed to fetch item ${id} after ${FETCH_RETRIES} attempts:`, err.message);
        return null;
    }
}

function determineChannel(item) {
    if (!item?.title || !item.time || item.time <= BOT_START_TIME) return null;

    if (item.type === 'job') return JOB_CHANNEL_ID;

    if (item.type === 'story') {
        const lower = item.title.toLowerCase();
        if (lower.startsWith('show hn')) return SHOW_CHANNEL_ID;
        if (lower.startsWith('ask hn')) return null;
        return NEWS_CHANNEL_ID;
    }

    return null;
}

async function processItem(id) {
    if (postedIds.has(id)) return;
    // Fix #1: claim the ID immediately to prevent concurrent duplicate posts
    postedIds.add(id);

    try {
        const item = await fetchItemWithRetry(id);
        if (!item) {
            postedIds.delete(id); // release so a future run can retry
            return;
        }

        if (!['story', 'job'].includes(item.type)) {
            console.log(`Skipping non-story/job item ${id} (type: ${item.type})`);
            postedIds.delete(id);
            return;
        }

        const channelId = determineChannel(item);
        if (!channelId) {
            postedIds.delete(id);
            return;
        }

        // Fix #11: prefer cache, fall back to fetch
        const channel = client.channels.cache.get(channelId) ?? await client.channels.fetch(channelId);
        const hnUrl = `https://news.ycombinator.com/item?id=${id}`;
        const displayUrl = item.url ? encodeURI(item.url) : hnUrl;

        const embed = new EmbedBuilder()
            .setColor(0xFF6600)
            .setTitle(item.title)
            .setURL(displayUrl)
            .setDescription(`[💬 Discuss on HN](${hnUrl})`)
            .setFooter({ text: 'Hacker News', iconURL: 'https://news.ycombinator.com/favicon.ico' })
            .setTimestamp(item.time * 1000);

        if (!item.url) embed.setURL(hnUrl);

        await channel.send({ embeds: [embed] });
        scheduleSave();
        console.log(`Posted item ${id} to channel ${channelId}`);

        // Fix #4: delay only after an actual network request, not for skipped items
        await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY));
    } catch (err) {
        postedIds.delete(id); // release so the item can be retried
        console.error(`Error processing item ${id}:`, err);
    }
}

async function fetchMaxItem() {
    try {
        const res = await fetch('https://hacker-news.firebaseio.com/v0/maxitem.json');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (err) {
        console.error('Failed to fetch maxitem:', err.message);
        return null;
    }
}

async function deleteOldMessages(channelId) {
    const channel = client.channels.cache.get(channelId) ?? await client.channels.fetch(channelId);
    const cutoff = Date.now() - MESSAGE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const bulkCutoff = Date.now() - BULK_DELETE_LIMIT_MS;
    let lastId;
    let totalDeleted = 0;

    while (true) {
        const options = { limit: 100 };
        if (lastId) options.before = lastId;

        const messages = await channel.messages.fetch(options);
        if (messages.size === 0) break;

        lastId = messages.last().id;

        const toDelete = messages.filter(m => m.createdTimestamp < cutoff);

        // Messages under 14 days old can be bulk-deleted (up to 100 at once)
        const bulk = toDelete.filter(m => m.createdTimestamp > bulkCutoff);
        if (bulk.size > 0) {
            await channel.bulkDelete(bulk);
            totalDeleted += bulk.size;
        }

        // Messages over 14 days old must be deleted one by one
        for (const msg of toDelete.filter(m => m.createdTimestamp <= bulkCutoff).values()) {
            await msg.delete();
            totalDeleted++;
            await new Promise(r => setTimeout(r, 500)); // avoid rate limits
        }

        if (messages.size < 100) break;
    }

    if (totalDeleted > 0) console.log(`Deleted ${totalDeleted} old messages from channel ${channelId}`);
}

async function cleanupAllChannels() {
    console.log(`Running message cleanup (max age: ${MESSAGE_MAX_AGE_DAYS} days)...`);
    for (const channelId of [SHOW_CHANNEL_ID, JOB_CHANNEL_ID, NEWS_CHANNEL_ID]) {
        try {
            await deleteOldMessages(channelId);
        } catch (err) {
            console.error(`Error cleaning up channel ${channelId}:`, err);
        }
    }
}

function startCleanup() {
    setInterval(cleanupAllChannels, CLEANUP_INTERVAL);
}

// Fix #9: replaced Firebase SDK listener with a plain poll
function startPolling() {
    setInterval(async () => {
        const currentMaxItem = await fetchMaxItem();
        if (!currentMaxItem || currentMaxItem <= LAST_MAX_ITEM) return;

        console.log(`New max item detected: ${currentMaxItem}`);
        // Fix #2: update LAST_MAX_ITEM before the loop to prevent overlapping ranges
        const fromId = LAST_MAX_ITEM;
        LAST_MAX_ITEM = currentMaxItem;

        for (let id = currentMaxItem; id > fromId; id--) {
            await processItem(id);
        }
    }, POLL_INTERVAL);
}

// Fix #10: graceful shutdown — flush state before exit
async function shutdown() {
    console.log('Shutting down, saving state...');
    await savePostedIds();
    process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    BOT_START_TIME = Math.floor(Date.now() / 1000);
    await loadPostedIds();

    const initialMaxItem = await fetchMaxItem();
    if (!initialMaxItem) {
        console.error('Could not fetch initial maxitem, exiting.');
        process.exit(1);
    }
    LAST_MAX_ITEM = initialMaxItem;

    startPolling();
    startCleanup();
});

client.login(BOT_TOKEN);
