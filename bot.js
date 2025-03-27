require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes } = require('discord.js');
const { google } = require('googleapis');
const { MongoClient } = require('mongodb');
const express = require('express');
process.on('unhandledRejection', (error) => {
  console.error('Unhandled Promise Rejection:', error);
});

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
    formChannels = new Map(docs.map(doc => [
      doc.spreadsheet_id, 
      { 
        channelId: doc.channel_id, 
        sheet_name: doc.sheet_name 
      }
    ]));
    console.log('✅ MongoDB initialized');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    process.exit(1);
  }
}

// Google authentication
async function getAuthClient() {
  try {
    console.log('🔑 Authenticating with service account:', serviceAccount.client_email);
    
    const auth = new google.auth.JWT({
      email: serviceAccount.client_email,
      key: serviceAccount.private_key.replace(/\\n/g, '\n'),
      scopes: SCOPES
    });
    
    await auth.authorize();
    console.log('✅ Google auth successful');
    return auth;
  } catch (error) {
    console.error('❌ Auth failed - Check your service account JSON:', {
      client_email: serviceAccount?.client_email,
      error: error.message
    });
    throw error;
  }
}

// Sheet data fetching
async function fetchResponses(spreadsheetId, sheetName) {
  try {
    console.log(`🔍 Fetching data from ${sheetName} in ${spreadsheetId}`);
    
    const auth = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    // Get headers (first row)
    const headerResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'!1:1`,
    });
    const headers = headerResponse.data.values?.[0] || [];

    // Get response data (skip header row)
    const dataResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'!A2:Z`,
    });

    return {
      headers,
      values: dataResponse.data.values || []
    };
  } catch (error) {
    console.error(`❌ Failed to fetch ${sheetName}:`, error.message);
    return null;
  }
}

// Response processing
async function processSpreadsheet(spreadsheetId, channelId) {
  try {
    const auth = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    // Get all sheet names in the spreadsheet
    const metadata = await sheets.spreadsheets.get({
      spreadsheetId,
    });
    const sheetNames = metadata.data.sheets.map(sheet => sheet.properties.title);

    for (const sheetName of sheetNames) {
      try {
        const response = await fetchResponses(spreadsheetId, sheetName);
        if (!response || !response.values) continue;

        const { headers, values } = response;
        const lastRowDoc = await lastRowsCollection.findOne({ 
          spreadsheet_id: spreadsheetId,
          sheet_name: sheetName 
        });
        const lastProcessedRow = lastRowDoc?.last_row || 0;

        if (values.length > lastProcessedRow) {
          const newResponses = values.slice(lastProcessedRow);
          await sendResponses(channelId, headers, newResponses, sheetName);
          
          await lastRowsCollection.updateOne(
            { 
              spreadsheet_id: spreadsheetId,
              sheet_name: sheetName 
            },
            { $set: { last_row: values.length } },
            { upsert: true }
          );
          console.log(`✅ Processed ${newResponses.length} new responses from ${sheetName}`);
        }
      } catch (error) {
        console.error(`❌ Error processing ${sheetName}:`, error);
      }
    }
  } catch (error) {
    console.error(`❌ Error processing spreadsheet ${spreadsheetId}:`, error);
  }
}

// Discord message sending
async function sendResponses(channelId, headers, responses, sheetName) {
  const channel = client.channels.cache.get(channelId);
  if (!channel) {
    console.error(`❌ Channel ${channelId} not found`);
    return;
  }

  for (const response of responses) {
    try {
      const embed = new EmbedBuilder()
        .setTitle(`📝 New Response (${sheetName})`)
        .setColor(0x00FF00);

      response.forEach((value, index) => {
        const question = headers[index] || `Question ${index + 1}`;
        embed.addFields({
          name: question,
          value: value?.toString().substring(0, 1000) || 'No response',
          inline: false
        });
      });

      await channel.send({ embeds: [embed] });
    } catch (error) {
      console.error('❌ Failed to send response:', error);
    }
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

    await interaction.reply({
      content: `📂 Available Spreadsheets:\n${data.files.map(f => `- ${f.name}`).join('\n')}\n\nType the exact name of the spreadsheet to track:`,
      ephemeral: true
    });
  } catch (error) {
    console.error('❌ Addform error:', error);
    await interaction.reply('⚠️ Failed to fetch spreadsheets');
  }
}

// Polling mechanism
async function pollSheets() {
  console.log('🔍 Polling sheets...');
  console.log('📋 Currently tracked spreadsheets:', Array.from(formChannels.keys()));
  
  if (formChannels.size === 0) {
    console.log('ℹ️ No spreadsheets being tracked');
    return;
  }

  for (const [spreadsheetId, { channelId }] of formChannels) {
    await processSpreadsheet(spreadsheetId, channelId);
  }
}

// Bot setup
client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  await initializeDatabase();
  
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Slash commands registered');
  } catch (error) {
    console.error('❌ Failed to register commands:', error);
  }
  
  setInterval(pollSheets, 60000);
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
        const spreadsheetName = interaction.options.getString('sheetname');
        const entry = [...formChannels.entries()].find(
          ([_, config]) => config.sheet_name === spreadsheetName
        );
        
        if (entry) {
          formChannels.delete(entry[0]);
          await formChannelsCollection.deleteOne({ spreadsheet_id: entry[0] });
          await interaction.reply(`✅ Stopped tracking ${spreadsheetName}`);
        } else {
          await interaction.reply('❌ Spreadsheet not being tracked');
        }
        break;

      case 'listforms':
        const list = Array.from(formChannels)
          .map(([id, { channelId, sheet_name }]) => 
            `- ${sheet_name} (${id}) → <#${channelId}>`
          )
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
      if (!spreadsheet) return message.reply('❌ Invalid spreadsheet name');

      state.spreadsheet = spreadsheet;
      state.step = 'selectChannel';
      await message.reply('Mention the channel to receive responses:');
    }
    else if (state.step === 'selectChannel') {
      const channelId = message.mentions.channels.first()?.id;
      if (!channelId) {
        return message.reply('❌ Please mention a valid text channel');
      }

      formChannels.set(state.spreadsheet.id, {
        channelId,
        sheet_name: state.spreadsheet.name
      });

      await formChannelsCollection.insertOne({
        sheet_name: state.spreadsheet.name,
        channel_id: channelId,
        spreadsheet_id: state.spreadsheet.id
      });

      await message.reply(`✅ Now tracking ${state.spreadsheet.name} in <#${channelId}>`);
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
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Web server listening on port ${PORT}`));

client.login(process.env.DISCORD_TOKEN);
