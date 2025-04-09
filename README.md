# Hacker News Discord Bot

A Discord bot that automatically posts new Hacker News stories to designated channels in real-time, filtered by category (Show HN, Jobs, and News). Built with Node.js and Firebase.

![Bot Demo](https://via.placeholder.com/800x400.png?text=Hacker+News+Bot+Demo+Preview)

## Features
- 🚀 **Real-time Updates**: Uses Firebase listeners for instant notifications
- 📰 **Category Filtering**: 
  - `Show HN` → Showcase channel
  - `Jobs` → Jobs channel 
  - `News` → General news channel
- ⚠️ **Duplicate Prevention**: Tracks posted IDs persistently
- ⏱ **Time Filter**: Only posts stories created *after* bot startup
- 🔧 **Configurable**: Easy setup via `.env` file

## Prerequisites
- Node.js v18+
- Discord server with manage channels permission
- [Firebase Account](https://firebase.google.com/) (Free tier)

## Setup Guide

### 1. Create Discord Bot
1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create New Application → Bot → Copy **BOT_TOKEN**
3. Invite bot to your server with these permissions:
   - `View Channels`
   - `Send Messages`
   - `Embed Links`

### 2. Configure Environment
Create `.env` file:
```env
BOT_TOKEN=your_discord_bot_token
SHOW_CHANNEL_ID=123456789012345678
JOB_CHANNEL_ID=123456789012345678 
NEWS_CHANNEL_ID=123456789012345678
```

### 3. Install Dependencies

```
npm install discord.js firebase dotenv axios
```
### 4. Channel ID Setup

1. In Discord:
    - Create channels for each category
    - Right-click channel → "Copy ID" (Enable Developer Mode first)
2. Update .env with the copied IDs


## Running the Bot
```
node src/main.js
```

For production use:
```
npm install -g pm2
pm2 start src/main.js --name hn-bot

```

## Troubleshooting

### Common Issues

1. Missing Permissions:

    - Ensure bot has Send Messages permission
    - Check channel visibility settings

2. Firebase Connection Errors:
    ```
    npm install firebase@latest
    ```

3. File Access Errors:
    ```
    chmod 664 posted.json
    ```

## License

MIT License - Free for modification and redistribution
