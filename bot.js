require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes } = require('discord.js');
const { google } = require('googleapis');
const { MongoClient } = require('mongodb');
const express = require('express');

// Slash commands configuration
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
        type: 3,
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

// Environment validation
const REQUIRED_ENV = ['DISCORD_TOKEN', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'MONGO_URI'];
REQUIRED_ENV.forEach(variable => {
  if (!process.env[variable]) throw new Error(`Missing ${variable} in .env`);
});

// Client initialization
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Google API configuration
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly', 'https://www.googleapis.com/auth/drive.readonly'];
const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

// Database setup
const mongoClient = new MongoClient(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

let db, formChannelsCollection, lastRowsCollection;
let formChannels = new Map();
let interactionState = {};

// Polling limits configuration
const POLLING_INTERVAL = parseInt(process.env.POLLING_INTERVAL || '60000', 10); // Default to 60 seconds
const MAX_API_CALLS_PER_MINUTE = 60; // Adjust based on Google's rate limits
let apiCallCount = 0;
const apiCallTimestamps = [];

// Database initialization
async function initializeDatabase() {
  try {
    await mongoClient.connect();
    db = mongoClient.db('prs-helper');
    
    const collections = await db.listCollections().toArray();
    if (!collections.some(c => c.name === 'form_channels')) {
      await db.createCollection('form_channels');
    }
    if (!collections.some(c => c.name === 'last_rows')) {
      await db.createCollection('last_rows');
    }
    
    formChannelsCollection = db.collection('form_channels');
    lastRowsCollection = db.collection('last_rows');
    
    const docs = await formChannelsCollection.find().toArray();
    formChannels = new Map(docs.map(doc => [doc.sheet_name, doc]));
    console.log('✅ MongoDB initialized');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    process.exit(1);
  }
}

// Google authentication
async function getAuthClient() {
  try {
    const auth = new google.auth.JWT({
      email: serviceAccount.client_email,
      key: serviceAccount.private_key.replace(/\\n/g, '\n'),
      scopes: SCOPES
    });
    await auth.authorize();
    return auth;
  } catch (error) {
    console.error('❌ Google auth failed:', error);
    throw error;
  }
}

// Rate limiting
function checkRateLimit() {
  const now = Date.now();
  apiCallTimestamps.push(now);

  // Remove timestamps older than 1 minute
  while (apiCallTimestamps.length && apiCallTimestamps[0] <= now - 60000) {
    apiCallTimestamps.shift();
  }

  if (apiCallTimestamps.length >= MAX_API_CALLS_PER_MINUTE) {
    return false;
  }

  return true;
}

// Sheet data fetching
async function fetchResponses(spreadsheetId) {
  try {
    if (!checkRateLimit()) {
      console.warn('⚠️ API call limit reached. Skipping this poll.');
      return null;
    }

    console.log(`Fetching data from spreadsheet: ${spreadsheetId}`);

    const auth = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    // List sheets to get their names
    const sheetMetadata = await sheets.spreadsheets.get({
      spreadsheetId,
    });

    const sheetNames = sheetMetadata.data.sheets.map(sheet => sheet.properties.title);
    console.log(`Available sheets: ${sheetNames.join(', ')}`);

    // Fetch data from all sheets
    const ranges = sheetNames.map(name => `'${name}'!A:Z`);
    const response = await sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges,
    });

    return response.data.valueRanges || [];
  } catch (error) {
    console.error(`❌ Failed to fetch data from spreadsheet: ${spreadsheetId}`, error.message);
    if (error.response?.data?.error) {
      console.error('Google API Error:', error.response.data.error);
    }
    return null;
  }
}

// Response processing
async function processSpreadsheet(spreadsheetId, channelId) {
  try {
    const valueRanges = await fetchResponses(spreadsheetId);
    if (!valueRanges) return;

    for (const valueRange of valueRanges) {
      const responses = valueRange.values;
      const sheetName = valueRange.range.split('!')[0].replace(/'/g, '');
      console.log(`Processing sheet: ${sheetName}`);

      const lastRowDoc = await lastRowsCollection.findOne({ sheet_name: sheetName });
      const lastProcessedRow = lastRowDoc?.last_row || 0;

      if (responses.length > lastProcessedRow) {
        const newResponses = responses.slice(lastProcessedRow);
        await sendResponses(channelId, newResponses);
        await lastRowsCollection.updateOne(
          { sheet_name: sheetName },
          { $set: { last_row: responses.length } },
          { upsert: true }
        );
        console.log(`✅ Processed ${newResponses.length} new responses for ${sheetName}`);
      }
    }
  } catch (error) {
    console.error(`❌ Error processing spreadsheet: ${spreadsheetId}`, error);
  }
}

// Discord message sending
async function sendResponses(channelId, responses) {
  const channel = client.channels.cache.get(channelId);
  if (!channel) return;

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
}

// Command handlers
async function handleAddForm(interaction) {
  try {
    const auth = await getAuthClient();
    const drive = google.drive({ version: 'v3', auth });
    
    const { data } = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.spreadsheet'",
      fields: 'files(id, name)',
    });

    interactionState[interaction.user.id] = {
      step: 'selectSpreadsheet',
      spreadsheets: data.files
    };

    await interaction.reply(
      `Available Sheets:\n${data.files.map(f => `- ${f.name}`).join('\n')}\n` +
      'Type the exact sheet name to track:'
    );
  } catch (error) {
    console.error('❌ Addform error:', error);
    await interaction.reply('⚠️ Failed to fetch sheets');
  }
}

// Polling mechanism
async function pollSheets() {
  console.log('🔍 Polling sheets...');
  for (const [spreadsheetId, config] of formChannels) {
    await processSpreadsheet(spreadsheetId, config.channelId);
  }
}

// Bot setup
client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  await initializeDatabase();
  
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
  
  setInterval(pollSheets, POLLING_INTERVAL);
  console.log('✅ Bot operational');
});

// Interaction handling
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;

  try {
    switch (interaction.commandName) {
      case 'addform':
        return await handleAddForm(interaction);
      
      case 'removeform':
        const sheetName = interaction.options.getString('sheetname');
        if (formChannels.has(sheetName)) {
          formChannels.delete(sheetName);
          await formChannelsCollection.deleteOne({ sheet_name: sheetName });
          await interaction.reply(`✅ Stopped tracking ${sheetName}`);
        } else {
          await interaction.reply('❌ Sheet not being tracked');
        }
        break;

      case 'listforms':
        const list = Array.from(formChannels)
          .map(([spreadsheetId, { channelId }]) => `- ${spreadsheetId} → <#${channelId}>`)
          .join('\n') || 'No tracked forms';
        await interaction.reply(`📋 Tracked Forms:\n${list}`);
        break;

      case 'ping':
        const latency = Date.now() - interaction.createdTimestamp;
        await interaction.reply(`🏓 Pong! Latency: ${latency}ms`);
        break;
    }
  } catch (error) {
    console.error('❌ Interaction error:', error);
    await interaction.reply('⚠️ An error occurred');
  }
});

// Message handling for setup flow
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  const state = interactionState[message.author.id];
  if (!state) return;

  try {
    if (state.step === 'selectSpreadsheet') {
      const spreadsheet = state.spreadsheets.find(f => f.name === message.content.trim());
      if (!spreadsheet) return message.reply('❌ Invalid sheet name');

      state.spreadsheet = spreadsheet;
      state.step = 'selectChannel';
      await message.reply('Mention the channel to receive responses:');
    }
    else if (state.step === 'selectChannel') {
      const channelId = message.content.match(/\d+/)[0];
      const channel = client.channels.cache.get(channelId);
      
      if (!channel?.isTextBased()) {
        return message.reply('❌ Invalid channel mention');
      }

      formChannels.set(state.spreadsheet.id, {
        channelId,
      });

      await formChannelsCollection.insertOne({
        sheet_name: state.spreadsheet.name,
        channel_id: channelId,
        spreadsheet_id: state.spreadsheet.id
      });

      await message.reply(`✅ Now tracking ${state.spreadsheet.name} in ${channel.toString()}`);
      delete interactionState[message.author.id];
    }
  } catch (error) {
    console.error('❌ Setup error:', error);
    await message.reply('⚠️ Setup failed');
  }
});

// Web server
const app = express();
app.get('/', (req, res) => res.send('🟢 Bot Online'));
app.listen(process.env.PORT || 3000, () => 
  console.log(`🌐 Web server listening on port ${process.env.PORT || 3000}`)
);

client.login(process.env.DISCORD_TOKEN);
