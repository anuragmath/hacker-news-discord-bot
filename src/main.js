import { Client } from 'discord.js';
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, onValue } from 'firebase/database';
import { readFile, writeFile } from 'node:fs/promises';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

// Initialize Firebase
const firebaseConfig = {
    databaseURL: 'https://hacker-news.firebaseio.com'
};
const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);

// Discord setup
const client = new Client({ intents: [] });
const POSTED_IDS_FILE = 'posted.json';
let postedIds = new Set();
let BOT_START_TIME = 0; // Will be set when bot starts

// Environment variables
const {
    BOT_TOKEN,
    SHOW_CHANNEL_ID,
    JOB_CHANNEL_ID,
    NEWS_CHANNEL_ID
} = process.env;

// Load previously posted IDs
async function loadPostedIds() {
    try {
        const data = await readFile(POSTED_IDS_FILE, 'utf8');
        postedIds = new Set(JSON.parse(data));
    } catch (err) {
        if (err.code === 'ENOENT') {
            await writeFile(POSTED_IDS_FILE, '[]');
        } else {
            console.error('Error loading posted IDs:', err);
        }
    }
}

// Save IDs to avoid duplicates
async function savePostedIds() {
    await writeFile(POSTED_IDS_FILE, JSON.stringify([...postedIds]));
}

// Fetch HN item details
async function fetchItem(id) {
    try {
        const res = await axios.get(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
        return res.data;
    } catch (err) {
        console.error(`Failed to fetch item ${id}:`, err.message);
        return null;
    }
}

// Real-time listener for story lists
function setupListener(endpoint, channelId, type) {
    const storiesRef = ref(db, `/v0/${endpoint}`);

    onValue(storiesRef, async (snapshot) => {
        const newIds = new Set(snapshot.val());
        for (const id of newIds) {
            if (postedIds.has(id)) continue;

            const item = await fetchItem(id);
            if (!item || item.type !== (type === 'job' ? 'job' : 'story')) continue;

            // Check if story is newer than bot start time
            if (item.time < BOT_START_TIME) continue;

            const channel = await client.channels.fetch(channelId);
            const hnUrl = `https://news.ycombinator.com/item?id=${id}`;
            const message = [
                `**${item.title}**`,
                item.url || hnUrl,
                `Posted: ${new Date(item.time * 1000).toUTCString()}`
            ].join('\n');

            await channel.send(message);
            postedIds.add(id);
            await savePostedIds();
        }
    });
}

// Start bot
client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    BOT_START_TIME = Math.floor(Date.now() / 1000); // Set current time in seconds
    await loadPostedIds();

    // Set up real-time listeners
    setupListener('showstories', SHOW_CHANNEL_ID, 'show');
    setupListener('jobstories', JOB_CHANNEL_ID, 'job');
    setupListener('newstories', NEWS_CHANNEL_ID, 'news');
});

client.login(BOT_TOKEN);