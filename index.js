const {
    Client,
    GatewayIntentBits
} = require("discord.js");

const {
    joinVoiceChannel,
    VoiceConnectionStatus
} = require("@discordjs/voice");

const Database = require("better-sqlite3");

// ================================
// CẤU HÌNH
// ================================

const TOKEN = process.env.TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;
const JAIL_ROLE_ID = process.env.JAIL_ROLE_ID;

// ================================
// KIỂM TRA VARIABLES
// ================================

if (!TOKEN) {
