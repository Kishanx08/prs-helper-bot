require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { google } = require('googleapis');
const { MongoClient } = require('mongodb');
const express = require('express');
const path = require('path');
const { REST, Routes } = require('discord.js');

// Define your slash commands
const commands = [
  {
    name: 'addform',
    description: 'Start tracking a Google Form',
    options: [
      {
        name: 'sheetname',
        description: 'Name of the Google Sheet',
        type: 3, // STRING
        required: true,
      },
      {
        name: 'channelid',
        description: 'Channel to send responses',
        type: 3, // STRING
        required: true,
      },
    ],
  },
  {
    name: 'removeform',
    description: 'Stop tracking a Google Form',
    options: [
      {
        name: 'sheetname',
        description: 'Name of the Google Sheet',
        type: 3, // STRING
        required: true,
      },
    ],
  },
  {
    name: 'listforms',
    description: 'List all tracked forms',
  },
];

// Verify environment variables
const REQUIRED_ENV = ['DISCORD_TOKEN', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'MONGO_URI'];
REQUIRED_ENV.forEach(variable => {
  if (!process.env[variable]) throw new Error(`Missing ${variable} in .env file`);
});

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Google Sheets setup
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

// MongoDB setup
const mongoClient = new MongoClient(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

// Global variables
let db, formChannelsCollection, lastRowsCollection;
let formChannels = new Map();

// Initialize MongoDB collections
async function initializeDatabase() {
  try {
    await mongoClient.connect();
    db = mongoClient.db('prs-helpter');
    
    // Create collections if they don't exist
    const collections = await db.listCollections().toArray();
    if (!collections.some(c => c.name === 'form_channels')) {
      await db.createCollection('form_channels');
    }
    if (!collections.some(c => c.name === 'last_rows')) {
      await db.createCollection('last_rows');
    }
    
    formChannelsCollection = db.collection('form_channels');
    lastRowsCollection = db.collection('last_rows');
    
    // Load existing mappings
    const docs = await formChannelsCollection.find().toArray();
    formChannels = new Map(docs.map(doc => [doc.sheet_name, doc.channel_id]));
    
    console.log('✅ MongoDB initialized successfully');
  } catch (error) {
    console.error('❌ MongoDB initialization failed:', error);
    process.exit(1);
  }
}

// Google Sheets authentication
async function authorize() {
  try {
    const auth = new google.auth.JWT({
      email: serviceAccount.client_email,
      key: serviceAccount.private_key,
      scopes: SCOPES
    });
    await auth.authorize();
    return google.sheets({ version: 'v4', auth });
  } catch (error) {
    console.error('❌ Google Sheets auth failed:', error);
    throw error;
  }
}

// Fetch responses from Google Sheets
async function fetchResponses(sheets, sheetName) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: serviceAccount.spreadsheet_id,
      range: `${sheetName}!A:Z`
    });
    return response.data.values || [];
  } catch (error) {
    console.error(`❌ Failed to fetch ${sheetName}:`, error);
    return null;
  }
}

// Save last processed row
async function updateLastRow(sheetName, row) {
  try {
    await lastRowsCollection.updateOne(
      { sheet_name: sheetName },
      { $set: { last_row: row } },
      { upsert: true }
    );
  } catch (error) {
    console.error(`❌ Failed to update last row for ${sheetName}:`, error);
  }
}

// Send responses to Discord
async function sendResponses(channelId, responses) {
  try {
    const channel = client.channels.cache.get(channelId);
    if (!channel) {
      console.error(`❌ Channel ${channelId} not found`);
      return;
    }

    for (const response of responses) {
      const embed = new EmbedBuilder()
        .setTitle('📝 New Form Response')
        .setColor(0x00FF00)
        .addFields(response.map((value, index) => ({
          name: `Field ${index + 1}`,
          value: value.substring(0, 1000) || 'N/A',
          inline: false
        })));

      await channel.send({ embeds: [embed] });
    }
  } catch (error) {
    console.error(`❌ Failed to send to ${channelId}:`, error);
  }
}

// Check for new responses every 60 seconds
async function pollSheets() {
  try {
    const sheets = await authorize();
    
    for (const [sheetName, channelId] of formChannels) {
      try {
        const responses = await fetchResponses(sheets, sheetName);
        if (!responses || responses.length < 1) continue;

        const lastRowDoc = await lastRowsCollection.findOne({ sheet_name: sheetName });
        const lastProcessedRow = lastRowDoc ? lastRowDoc.last_row : 0;
        
        if (responses.length > lastProcessedRow) {
          const newResponses = responses.slice(lastProcessedRow);
          await sendResponses(channelId, newResponses);
          await updateLastRow(sheetName, responses.length);
        }
      } catch (error) {
        console.error(`❌ Error processing ${sheetName}:`, error);
      }
    }
  } catch (error) {
    console.error('❌ Polling failed:', error);
  }
}

// Register slash commands
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    console.log('🔧 Registering slash commands...');
    await rest.put(
      Routes.applicationCommands(client.user.id), // Register globally
      { body: commands }
    );
    console.log('✅ Slash commands registered successfully!');
  } catch (error) {
    console.error('❌ Failed to register commands:', error);
  }
}

// Discord commands
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;

  try {
    const { commandName, options } = interaction;

    if (commandName === 'addform') {
      const sheetName = options.getString('sheetname');
      const channelId = options.getString('channelid');

      if (formChannels.has(sheetName)) {
        return interaction.reply(`⚠️ ${sheetName} is already being tracked`);
      }

      // Initialize last row
      const sheets = await authorize();
      const responses = await fetchResponses(sheets, sheetName);
      const initialRow = responses ? responses.length : 0;

      formChannels.set(sheetName, channelId);
      await formChannelsCollection.insertOne({ sheet_name: sheetName, channel_id: channelId });
      await updateLastRow(sheetName, initialRow);

      interaction.reply(`✅ Now tracking ${sheetName} in <#${channelId}>`);
    }

    if (commandName === 'removeform') {
      const sheetName = options.getString('sheetname');
      
      if (!formChannels.has(sheetName)) {
        return interaction.reply(`⚠️ ${sheetName} is not being tracked`);
      }

      formChannels.delete(sheetName);
      await formChannelsCollection.deleteOne({ sheet_name: sheetName });
      await lastRowsCollection.deleteOne({ sheet_name: sheetName });

      interaction.reply(`✅ Stopped tracking ${sheetName}`);
    }

    if (commandName === 'listforms') {
      const list = Array.from(formChannels)
        .map(([name, id]) => `• ${name} → <#${id}>`)
        .join('\n') || 'No forms being tracked';
      
      interaction.reply(`📋 Tracked Forms:\n${list}`);
    }
  } catch (error) {
    console.error('❌ Command error:', error);
    interaction.reply('⚠️ An error occurred');
  }
});

// Start the bot
client.once('ready', async () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  await initializeDatabase();
  await registerCommands(); // <-- Add this line
  setInterval(pollSheets, 60000); // Check every minute
});

// Web server for uptime monitoring
const app = express();
app.get('/', (req, res) => res.send('🤖 Bot is running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Web server running on port ${PORT}`));

// Start everything
client.login(process.env.DISCORD_TOKEN);
