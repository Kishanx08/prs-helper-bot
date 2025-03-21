require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { google } = require('googleapis');
const { authenticate } = require('@google-cloud/local-auth');
const { MongoClient } = require('mongodb');
const express = require('express');
const path = require('path');

// Load environment variables
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GOOGLE_SERVICE_ACCOUNT_JSON = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const MONGO_URI = process.env.MONGO_URI;
const ERROR_CHANNEL_ID = process.env.ERROR_CHANNEL_ID; // Channel to send error notifications

if (!DISCORD_TOKEN || !GOOGLE_SERVICE_ACCOUNT_JSON || !MONGO_URI) {
  throw new Error('Missing environment variables!');
}

// Discord bot setup
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

// Google Sheets setup
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const CREDENTIALS_PATH = path.resolve(__dirname, 'credentials.json');

// MongoDB setup
const mongoClient = new MongoClient(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
let db, formChannelsCollection, lastRowsCollection;

// Load form_channels from MongoDB
async function loadFormChannels() {
  try {
    const formChannels = new Map();
    const documents = await formChannelsCollection.find().toArray();
    documents.forEach(doc => formChannels.set(doc.sheet_name, doc.channel_id));
    console.log('✅ Form channels loaded from MongoDB:', formChannels);
    return formChannels;
  } catch (error) {
    console.error('❌ Failed to load form channels:', error);
    throw error;
  }
}

// Save form_channels to MongoDB
async function saveFormChannels(formChannels) {
  try {
    await formChannelsCollection.deleteMany({});
    const documents = Array.from(formChannels.entries()).map(([sheet_name, channel_id]) => ({ sheet_name, channel_id }));
    if (documents.length > 0) {
      await formChannelsCollection.insertMany(documents);
    }
    console.log('✅ Form channels saved to MongoDB:', formChannels);
  } catch (error) {
    console.error('❌ Failed to save form channels:', error);
    throw error;
  }
}

// Load last_row from MongoDB
async function loadLastRow(sheetName) {
  try {
    const document = await lastRowsCollection.findOne({ sheet_name: sheetName });
    return document ? document.last_row : 1;
  } catch (error) {
    console.error(`❌ Failed to load last row for ${sheetName}:`, error);
    throw error;
  }
}

// Save last_row to MongoDB
async function saveLastRow(sheetName, lastRow) {
  try {
    await lastRowsCollection.updateOne(
      { sheet_name: sheetName },
      { $set: { last_row: lastRow } },
      { upsert: true }
    );
    console.log(`✅ Last row saved for ${sheetName}:`, lastRow);
  } catch (error) {
    console.error(`❌ Failed to save last row for ${sheetName}:`, error);
    throw error;
  }
}

// Authenticate with Google Sheets API
async function authorize() {
  try {
    const auth = await authenticate({
      keyfilePath: CREDENTIALS_PATH,
      scopes: SCOPES,
    });
    return google.sheets({ version: 'v4', auth });
  } catch (error) {
    console.error('❌ Failed to authenticate with Google Sheets:', error);
    throw error;
  }
}

// Fetch responses from Google Sheets
async function fetchResponses(sheets, sheetName) {
  try {
    const range = `${sheetName}!A1:Z`;
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SERVICE_ACCOUNT_JSON.spreadsheet_id,
      range,
    });
    return response.data.values;
  } catch (error) {
    console.error(`❌ Failed to fetch responses for ${sheetName}:`, error);
    throw error;
  }
}

// Send responses to Discord channel
async function sendResponsesToChannel(channelId, responses) {
  try {
    const channel = client.channels.cache.get(channelId);
    if (!channel) {
      console.error(`❌ Channel ${channelId} not found.`);
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('📝 New Google Form Response')
      .setColor(0x00FF00);

    responses.forEach(row => {
      embed.addFields(row.map((value, index) => ({
        name: `**Field ${index + 1}**`,
        value: value || 'N/A',
        inline: false,
      })));
    });

    await channel.send({ embeds: [embed] });
    console.log(`✅ Sent responses to channel ${channelId}.`);
  } catch (error) {
    console.error(`❌ Failed to send responses to channel ${channelId}:`, error);
    throw error;
  }
}

// Notify errors to a specific channel
async function notifyError(errorMessage) {
  try {
    if (!ERROR_CHANNEL_ID) return;
    const channel = client.channels.cache.get(ERROR_CHANNEL_ID);
    if (!channel) {
      console.error('❌ Error notification channel not found.');
      return;
    }
    await channel.send(`❌ **Error:** ${errorMessage}`);
  } catch (error) {
    console.error('❌ Failed to send error notification:', error);
  }
}

// Poll Google Sheets for new responses
async function pollSheets() {
  try {
    const sheets = await authorize();

    for (const [sheetName, channelId] of formChannels.entries()) {
      try {
        const responses = await fetchResponses(sheets, sheetName);
        const lastRow = await loadLastRow(sheetName);

        if (responses && responses.length > lastRow) {
          const newResponses = responses.slice(lastRow);
          await sendResponsesToChannel(channelId, newResponses);
          await saveLastRow(sheetName, responses.length);
        }
      } catch (error) {
        console.error(`❌ Error processing sheet ${sheetName}:`, error);
        await notifyError(`Error processing sheet ${sheetName}: ${error.message}`);
      }
    }
  } catch (error) {
    console.error('❌ Error in pollSheets:', error);
    await notifyError(`Error in pollSheets: ${error.message}`);
  }
}

// Discord bot commands
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  const { commandName, options } = interaction;

  try {
    if (commandName === 'addform') {
      const sheetName = options.getString('sheetname');
      const channelId = options.getString('channelid');

      if (formChannels.has(sheetName)) {
        await interaction.reply(`Form "${sheetName}" is already being tracked.`);
        return;
      }

      formChannels.set(sheetName, channelId);
      await saveFormChannels(formChannels);
      await interaction.reply(`Started tracking form "${sheetName}" in channel <#${channelId}>.`);
    }

    if (commandName === 'removeform') {
      const sheetName = options.getString('sheetname');

      if (!formChannels.has(sheetName)) {
        await interaction.reply(`Form "${sheetName}" is not being tracked.`);
        return;
      }

      formChannels.delete(sheetName);
      await saveFormChannels(formChannels);
      await interaction.reply(`Stopped tracking form "${sheetName}".`);
    }

    if (commandName === 'listforms') {
      const formList = Array.from(formChannels.entries())
        .map(([sheetName, channelId]) => `${sheetName} -> <#${channelId}>`)
        .join('\n');

      await interaction.reply(`**Tracked Forms:**\n${formList || 'No forms are being tracked.'}`);
    }

    if (commandName === 'ping') {
      await interaction.reply('Pong! 🏓');
    }
  } catch (error) {
    console.error('❌ Error handling command:', error);
    await interaction.reply('❌ An error occurred while processing your command.');
    await notifyError(`Error handling command ${commandName}: ${error.message}`);
  }
});

// Start the bot
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  try {
    // Connect to MongoDB
    await mongoClient.connect();
    db = mongoClient.db('prs-helpter');
    formChannelsCollection = db.collection('form_channels');
    lastRowsCollection = db.collection('last_rows');

    // Load form channels
    formChannels = await loadFormChannels();

    // Start polling Google Sheets
    setInterval(pollSheets, 60000); // Poll every 60 seconds
  } catch (error) {
    console.error('❌ Error during bot startup:', error);
    await notifyError(`Error during bot startup: ${error.message}`);
  }
});

// Flask-like web server to keep the bot alive
const app = express();
app.get('/', (req, res) => res.send('✅ Bot is running!'));
app.listen(5000, () => console.log('Web server is running on port 5000.'));

// Login to Discord
client.login(DISCORD_TOKEN);
