require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes } = require('discord.js');
const { google } = require('googleapis');
const { MongoClient } = require('mongodb');
const express = require('express');

// Define your slash commands
const commands = [
  {
    name: 'addform',
    description: 'Start tracking a Google Form',
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
  {
    name: 'ping',
    description: 'Check bot latency and API status',
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
    db = mongoClient.db('prs-helper');
    
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
    formChannels = new Map(docs.map(doc => [doc.sheet_name, { channelId: doc.channel_id, spreadsheetId: doc.spreadsheet_id }]));
    
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

// Fetch all Google Sheets
async function fetchAllSheets(sheets) {
  try {
    const response = await sheets.spreadsheets.list();
    if (!response.data.spreadsheets) {
      throw new Error('No spreadsheets found.');
    }
    return response.data.spreadsheets;
  } catch (error) {
    console.error('❌ Failed to fetch spreadsheets:', error.message);
    return [];
  }
}

// Fetch responses from Google Sheets
async function fetchResponses(sheets, spreadsheetId, sheetName) {
  try {
    if (!spreadsheetId) {
      throw new Error('Spreadsheet ID is missing');
    }

    console.log(`Fetching data from sheet: ${sheetName} in spreadsheet: ${spreadsheetId}`);

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A:Z`,
    });

    if (!response.data.values) {
      throw new Error(`Sheet "${sheetName}" has no data or does not exist.`);
    }

    console.log(`Successfully fetched data from sheet: ${sheetName}`);

    return response.data.values;
  } catch (error) {
    console.error(`❌ Failed to fetch ${sheetName}:`, error.message);
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

    for (const [sheetName, { channelId, spreadsheetId }] of formChannels) {
      try {
        const responses = await fetchResponses(sheets, spreadsheetId, sheetName);
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
  if (!interaction.isCommand() && !interaction.isMessageComponent()) return;

  try {
    const { commandName, customId, options } = interaction;

    if (commandName === 'addform') {
      const sheets = await authorize();
      const allSheets = await fetchAllSheets(sheets);
      const sheetNames = allSheets.map(sheet => sheet.properties.title).join('\n');

      await interaction.reply(`Here are the available Google Sheets:\n\n${sheetNames}\n\nPlease type the name of the sheet you want to track.`);

      // Store interaction state
      interaction.state = { step: 'selectSheet', sheets: allSheets };
    }

    if (interaction.state?.step === 'selectSheet' && interaction.isMessage()) {
      const sheetName = interaction.content.trim();
      const selectedSheet = interaction.state.sheets.find(sheet => sheet.properties.title === sheetName);

      if (!selectedSheet) {
        return interaction.reply(`❌ Sheet "${sheetName}" does not exist. Please type a valid sheet name.`);
      }

      interaction.state.sheetName = sheetName;
      interaction.state.spreadsheetId = selectedSheet.spreadsheetId;

      await interaction.reply('Great! Now mention the channel where responses should be sent.');
      interaction.state.step = 'selectChannel';
    }

    if (interaction.state?.step === 'selectChannel' && interaction.isMessage()) {
      const channelId = interaction.content.replace('<#', '').replace('>', '').trim();
      const channel = client.channels.cache.get(channelId);

      if (!channel || !channel.isTextBased()) {
        return interaction.reply(`❌ Invalid channel ID: <#${channelId}>. Please provide a valid text channel ID.`);
      }

      const { sheetName, spreadsheetId } = interaction.state;
      const sheets = await authorize();
      const responses = await fetchResponses(sheets, spreadsheetId, sheetName);
      const initialRow = responses ? responses.length : 0;

      formChannels.set(sheetName, { channelId, spreadsheetId });
      await formChannelsCollection.insertOne({ sheet_name: sheetName, channel_id: channelId, spreadsheet_id: spreadsheetId });
      await updateLastRow(sheetName, initialRow);

      interaction.reply(`✅ Now tracking ${sheetName} in <#${channelId}>`);
      delete interaction.state;
    }

    if (commandName === 'removeform') {
      const sheetName = options.getString('sheetname');

      // Check if the sheet is being tracked
      if (!formChannels.has(sheetName)) {
        return interaction.reply(`❌ ${sheetName} is not being tracked.`);
      }

      // Remove the sheet from tracking
      formChannels.delete(sheetName);
      await formChannelsCollection.deleteOne({ sheet_name: sheetName });

      interaction.reply(`✅ Stopped tracking ${sheetName}.`);
    }

    if (commandName === 'listforms') {
      const list = Array.from(formChannels)
        .map(([name, { channelId }]) => `• ${name} → <#${channelId}>`)
        .join('\n') || 'No forms are being tracked';

      interaction.reply(`📋 Tracked Forms:\n${list}`);
    }

    if (commandName === 'ping') {
      // Calculate bot latency
      const startTime = Date.now();
      await interaction.deferReply(); // Acknowledge the interaction
      const latency = Date.now() - startTime;

      // Test Google Sheets API
      let sheetsStatus = '✅ Google Sheets API is working';
      try {
        const sheets = await authorize();
        await sheets.spreadsheets.values.get({
          spreadsheetId: '1GxRAedaT2dGYjf1TurrCxLk98vnVeN_Cffs848tD5RM', // Use a dummy ID to test the API
          range: 'Sheet1!A:Z',
        });
      } catch (error) {
        sheetsStatus = '❌ Google Sheets API is not working';
      }

      // Send response
      await interaction.editReply({
        content: `🏓 Pong!\n- Bot Latency: ${latency}ms\n- ${sheetsStatus}`,
      });
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
  await registerCommands();
  setInterval(pollSheets, 60000); // Check every minute
});

// Web server for uptime monitoring
const app = express();
app.get('/', (req, res) => res.send('🤖 Bot is running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Web server running on port ${PORT}`));

// Start everything
client.login(process.env.DISCORD_TOKEN);
