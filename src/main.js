import { Client } from 'discord.js';
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, onValue } from 'firebase/database';
import { readFile, writeFile } from 'node:fs/promises';
import dotenv from 'dotenv';

dotenv.config();

// Initialize Firebase
const firebaseConfig = { databaseURL: 'https://hacker-news.firebaseio.com' };
const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);

// Discord setup
const client = new Client({ intents: [] });
const POSTED_IDS_FILE = 'posted.json';
let postedIds = new Set();
let BOT_START_TIME = 0;
let LAST_MAX_ITEM = 0;


// Environment variables
const {
    BOT_TOKEN,
    SHOW_CHANNEL_ID,
    JOB_CHANNEL_ID,
    NEWS_CHANNEL_ID
} = process.env;


// Add request cache and rate limiting
const FETCH_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second
const REQUEST_DELAY = 100; // 100ms between requests

async function loadPostedIds() {
    try {
        const data = await readFile(POSTED_IDS_FILE, 'utf8');
        postedIds = new Set(JSON.parse(data));
    } catch (err) {
        if (err.code === 'ENOENT') await writeFile(POSTED_IDS_FILE, '[]');
        else console.error('Error loading posted IDs:', err);
    }
}

async function savePostedIds() {
    await writeFile(POSTED_IDS_FILE, JSON.stringify([...postedIds]));
}

async function fetchItemWithRetry(id, retries = FETCH_RETRIES) {
    try {
        const res = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        // Validate basic item structure
        if (!data || typeof data !== 'object' || !data.id) {
            throw new Error('Invalid item format');
        }
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

function isValidStory(item) {
    return item &&
        item.type === 'story' &&
        item.title &&
        item.time &&
        item.time > BOT_START_TIME;
}

function isValidJob(item) {
    return item &&
        item.type === 'job' &&
        item.title &&
        item.time &&
        item.time > BOT_START_TIME;
}

function determineChannel(item) {
    if (isValidJob(item)) {
        return JOB_CHANNEL_ID;
    }

    if (isValidStory(item)) {
        const lowerTitle = (item.title || '').toLowerCase();
        if (lowerTitle.startsWith('show hn')) return SHOW_CHANNEL_ID;
        if (lowerTitle.startsWith('ask hn')) return null;
        return NEWS_CHANNEL_ID;
    }

    return null;
}

async function processItem(id) {
    if (postedIds.has(id)) return;

    try {
        const item = await fetchItemWithRetry(id);
        if (!item) return;

        // Skip comments and invalid items
        if (!['story', 'job'].includes(item.type)) {
            console.log(`Skipping non-story/job item ${id} (type: ${item.type})`);
            return;
        }

        const channelId = determineChannel(item);
        if (!channelId) return;

        const channel = await client.channels.fetch(channelId);
        const hnUrl = `https://news.ycombinator.com/item?id=${id}`;

        // Escape markdown special characters in title
        const escapedTitle = item.title
            .replace(/[[\]()]/g, '\\$&')
            .replace(/_/g, '\\_');

        // Create masked URL
        const displayUrl = item.url ? encodeURI(item.url) : hnUrl;
        const titleLink = `**[${escapedTitle}](${displayUrl})**`;

        const message = [
             titleLink,
            `*Posted: ${new Date(item.time * 1000).toUTCString()}*`
        ].join('\n');

        await channel.send(message);
        postedIds.add(id);
        await savePostedIds();
        console.log(`Successfully posted item ${id} to channel ${channelId}`);
    } catch (err) {
        console.error(`Error processing item ${id}:`, err);
    } finally {
        // Add delay between requests
        await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY));
    }
}

function setupMaxItemListener() {
    const maxItemRef = ref(db, '/v0/maxitem');

    onValue(maxItemRef, async (snapshot) => {
        const currentMaxItem = snapshot.val();
        console.log(`New max item detected: ${currentMaxItem}`);

        if (currentMaxItem > LAST_MAX_ITEM) {
            // Process items in reverse order (newest first)
            for (let id = currentMaxItem; id > LAST_MAX_ITEM; id--) {
                await processItem(id);
            }
            LAST_MAX_ITEM = currentMaxItem;
        }
    });
}

client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    BOT_START_TIME = Math.floor(Date.now() / 1000);
    await loadPostedIds();

    const initialMaxItem = await fetch('https://hacker-news.firebaseio.com/v0/maxitem.json')
        .then(res => res.json());
    LAST_MAX_ITEM = initialMaxItem;

    setupMaxItemListener();
});

client.login(BOT_TOKEN);