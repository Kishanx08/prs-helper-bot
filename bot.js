require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes } = require('discord.js');
const { google } = require('googleapis');
const { MongoClient } = require('mongodb');
const express = require('express');
const { RateLimiter } = require('limiter');

// Error handling
process.on('unhandledRejection', (error) => {
  console.error('Unhandled Promise Rejection:', error);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

// Rate limiter (50 requests/minute for Google Sheets API)
const limiter = new RateLimiter({ tokensPerInterval: 50, interval: 'minute' });

// Slash commands
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

// Validate environment
const REQUIRED_ENV = ['DISCORD_TOKEN', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'MONGO_URI'];
REQUIRED_ENV.forEach(variable => {
  if (!process.env[variable]) throw new Error(`Missing ${variable} in .env`);
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
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly', 'https://www.googleapis.com/auth/drive.readonly'];
const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

// MongoDB setup
const mongoClient = new MongoClient(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  retryWrites: true,
  retryReads: true
});

mongoClient.on('error', (err) => {
  console.error('MongoDB Error:', err);
});

let db, formChannelsCollection, lastRowsCollection;
let formChannels = new Map();
let interactionState = {};

// Initialize database
async function initializeDatabase() {
  try {
    await mongoClient.connect();
    db = mongoClient.db('prs-helper');
    
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

// Google auth
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

// Fetch responses with rate limiting
async function fetchResponses(spreadsheetId, sheetName) {
  await limiter.removeTokens(1);
  try {
    const auth = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    const [headerResponse, dataResponse] = await Promise.all([
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${sheetName}'!1:1`,
      }),
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${sheetName}'!A2:Z`,
      })
    ]);

    return {
      headers: headerResponse.data.values?.[0] || [],
      values: dataResponse.data.values || []
    };
  } catch (error) {
    console.error(`❌ Failed to fetch ${sheetName}:`, error.message);
    return null;
  }
}

// Process spreadsheet with retries
async function processSpreadsheet(spreadsheetId, channelId, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const auth = await getAuthClient();
      const sheets = google.sheets({ version: 'v4', auth });
      const metadata = await sheets.spreadsheets.get({ spreadsheetId });
      const sheetNames = metadata.data.sheets.map(sheet => sheet.properties.title);

      for (const sheetName of sheetNames) {
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
      }
      return; // Success
    } catch (error) {
      console.error(`Attempt ${attempt} failed for ${spreadsheetId}:`, error.message);
      if (attempt === retries) throw error;
      await new Promise(resolve => setTimeout(resolve, 5000)); // 5s backoff
    }
  }
}

// Send responses to Discord
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

// Poll all sheets in parallel
async function pollSheets() {
  if (!mongoClient.isConnected()) {
    console.log('⚠️ MongoDB disconnected, reconnecting...');
    await initializeDatabase();
  }

  console.log('🔍 Polling sheets...');
  if (formChannels.size === 0) {
    console.log('ℹ️ No spreadsheets being tracked');
    return;
  }

  await Promise.allSettled(
    Array.from(formChannels.entries()).map(
      async ([spreadsheetId, { channelId }]) => {
        try {
          await processSpreadsheet(spreadsheetId, channelId);
        } catch (error) {
          console.error(`❌ Failed polling ${spreadsheetId}:`, error.message);
        }
      }
    )
  );
  console.log('✅ Polling cycle completed');
}

// Discord bot setup
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
  
  // Start polling (60 seconds interval)
  setInterval(pollSheets, 60000);
  console.log('✅ Bot operational');
});

// Slash command handlers
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;

  try {
    switch (interaction.commandName) {
      case 'addform':
        await handleAddForm(interaction);
        break;
      
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

// Form setup flow
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

// Message handling for form setup
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

// Web server (for health checks)
const app = express();
app.get('/', (req, res) => res.send('🟢 Bot Online'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Web server listening on port ${PORT}`));

// Graceful shutdown
process.on('SIGINT', async () => {
  await mongoClient.close();
  client.destroy();
  process.exit(0);
});

// Start bot
client.login(process.env.DISCORD_TOKEN);
