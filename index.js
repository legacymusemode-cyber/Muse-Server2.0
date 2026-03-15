const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options(/.*/, cors()); // ← regex instead of '*'

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Wix API configuration
const WIX_API_KEY = process.env.WIX_API_KEY;
const WIX_ACCOUNT_ID = process.env.WIX_ACCOUNT_ID;
const WIX_SITE_ID = process.env.WIX_SITE_ID;

// Model configuration
const PRIMARY_MODEL = "deepseek/deepseek-v3.1-terminus:exacto";
const BACKUP_MODEL = "deepseek/deepseek-v3.2";
const TERTIARY_MODEL = "mistralai/mistral-large";

// Token costs per action
const TOKEN_COSTS = {
    unleash: 2,
    unhinge: 5,
    invoke: 2,
    devilPOV: 5,
    noMercy: 2,
    intensify: 2,
    characterChat: 1,
    overuse_scanner: 2,
    pacing_analyzer: 2,
    sentence_mechanics: 2,
    dialogue_critic: 2,
    ai_critic: 2,
    structural_check: 2
};

// ============================================
// AI CALL WITH FALLBACK + TRAINING DATA LOGGING
// ============================================
async function callAI(messages, temperature = 0.9, maxTokens = 2500, buttonType = null) {
  const models = [PRIMARY_MODEL, BACKUP_MODEL, TERTIARY_MODEL];
  const apiKey = process.env.OPENROUTER_API_KEY;
  
  if (!apiKey) {
    throw new Error("No API key configured");
  }
  
  for (const model of models) {
    try {
      console.log(`🤖 Trying model: ${model}`);
      
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://amayyzin.wixsite.com/website/devil-muse-server',
          'X-Title': 'Devil Muse'
        },
        body: JSON.stringify({
          model: model,
          messages: messages,
          temperature: temperature,
          max_tokens: maxTokens
        })
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ ${model} failed:`, errorText);
        continue;
      }
      
      const data = await response.json();
      const output = data.choices[0].message.content;
      console.log(`✅ Success with ${model}`);
      
      // 🔥 LOG TO TRAINING DATA FILE (only for writing functions)
      if (buttonType && shouldLogForTraining(buttonType)) {
        logTrainingData(buttonType, messages, output, model);
      }
      
      return output;
      
    } catch (error) {
      console.error(`❌ ${model} error:`, error.message);
      continue;
    }
  }
  
  throw new Error("All models failed");
}

// ============================================
// FILTER WHICH ACTIONS TO LOG
// ============================================
function shouldLogForTraining(buttonType) {
  const trainingActions = [
    'unhinge',
    'unleash', 
    'invoke',
    'intensify',
    'devilPOV'
  ];
  return trainingActions.includes(buttonType);
}

// ============================================
// TRAINING DATA LOGGER
// ============================================
function logTrainingData(buttonType, messages, output, model) {
  const fs = require('fs');
  const path = require('path');
  
  const trainingExample = {
    button: buttonType,
    messages: messages,
    output: output,
    model: model,
    timestamp: new Date().toISOString()
  };
  
  try {
    const logPath = path.join(__dirname, 'training_data.jsonl');
    fs.appendFileSync(logPath, JSON.stringify(trainingExample) + '\n');
    console.log(`📊 Logged training data: ${buttonType}`);
  } catch (err) {
    console.error('⚠️ Training log failed (non-critical):', err);
  }
}
// ============================================
// QUERY WIX CMS
// ============================================
async function queryWixCMS(collection, filter = {}, limit = 10) {
  try {
    console.log(`🔍 Querying Wix collection: ${collection}`);
    
    const response = await fetch(`https://www.wixapis.com/wix-data/v2/items/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': WIX_API_KEY,
        'wix-site-id': WIX_SITE_ID,
        'wix-account-id': WIX_ACCOUNT_ID
      },
      body: JSON.stringify({
        dataCollectionId: collection,
        query: {
          filter: filter,
          sort: [],
          paging: { limit: limit }
        }
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Wix API error for ${collection}:`, errorText);
      return { items: [] };
    }
    
    const data = await response.json();
    console.log(`✅ Found ${data.dataItems?.length || 0} items in ${collection}`);
    return { items: data.dataItems || [] };
    
  } catch (error) {
    console.error(`❌ Error querying ${collection}:`, error);
    return { items: [] };
  }
}

// ============================================
// CHECK AND DEDUCT INK TOKENS
// ============================================
async function checkAndDeductTokens(memberId, tokenCost, action) {
    if (!memberId) {
        console.log('⚠️ No memberId provided - skipping token check');
        return { success: true, tokensRemaining: 0 };
    }

    try {
        console.log(`🪙 Checking tokens for member: ${memberId} | Cost: ${tokenCost}`);

        const queryResponse = await fetch(
    'https://www.wixapis.com/wix-data/v2/items/query',
    {
        method: 'POST',
        headers: {
            'Authorization': WIX_API_KEY,
            'wix-site-id': WIX_SITE_ID,
            'wix-account-id': WIX_ACCOUNT_ID,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            dataCollectionId: 'InkTokens',
            options: { suppressCache: true },
            query: {
                filter: { memberId: { "$eq": memberId } }
            }
        })  // ← closes JSON.stringify
    }   // ← closes fetch options object
);  // ← closes fetch call

        const queryData = await queryResponse.json();

        if (!queryData.dataItems || queryData.dataItems.length === 0) {
            console.log('❌ No InkTokens record found for member');
            return { success: false, message: 'No Ink Token record found. Please log out and back in.' };
        }

        const record = queryData.dataItems[0].data;
        const itemId = record._id;

        // Check daily reset
        const now = new Date();
        const lastUpdated = new Date(record._updatedDate);
        const isNewDay =
            now.getUTCFullYear() !== lastUpdated.getUTCFullYear() ||
            now.getUTCMonth() !== lastUpdated.getUTCMonth() ||
            now.getUTCDate() !== lastUpdated.getUTCDate();
// ============================================
// IRON MARGINS FREE MONTHLY CHECK
// ============================================
const ironMarginActions = [
    'overuse_scanner',
    'pacing_analyzer', 
    'sentence_mechanics',
    'dialogue_critic',
    'ai_critic',
    'structural_check'
];

if (ironMarginActions.includes(action)) {
    
    // Check if new month
    const lastIronReset = record.ironMarginsReset 
        ? new Date(record.ironMarginsReset) 
        : new Date(0);
    
    const isNewMonth = 
        now.getUTCMonth() !== lastIronReset.getUTCMonth() ||
        now.getUTCFullYear() !== lastIronReset.getUTCFullYear();
    
    const currentUsed = isNewMonth ? 0 : (record.ironMarginsUsed || 0);
    
    console.log(`📜 Iron Margins used: ${currentUsed}/5 this month`);
    
    if (currentUsed < 5) {
        // Still has free uses - update count but skip token deduction
        await fetch(
            `https://www.wixapis.com/wix-data/v2/items/${itemId}`,
            {
                method: 'PUT',
                headers: {
                    'Authorization': WIX_API_KEY,
                    'wix-site-id': WIX_SITE_ID,
                    'wix-account-id': WIX_ACCOUNT_ID,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    dataCollectionId: 'InkTokens',
                    dataItem: {
                        data: {
                            ...record,
                            ironMarginsUsed: currentUsed + 1,
                            ironMarginsReset: isNewMonth 
                                ? now.toISOString() 
                                : record.ironMarginsReset
                        }
                    }
                })
            }
        );
        
        console.log(`✅ Iron Margins free use ${currentUsed + 1}/5 consumed`);
        return { 
            success: true, 
            tokensRemaining: currentTokens,
            freeUse: true,
            ironMarginsRemaining: 4 - currentUsed
        };
    }
    
    console.log(`💀 Iron Margins free uses exhausted - deducting 2 tokens`);
    // All 5 free uses gone - fall through to normal token deduction
}

        const PLAN_LIMITS = { free: 25, marked: 150, monster: 300 };
        let currentTokens = isNewDay
            ? (PLAN_LIMITS[record.plan] || 25)
            : record.tokensRemaining;

        console.log(`🪙 Tokens available: ${currentTokens} | Required: ${tokenCost} | Plan: ${record.plan}`);

        if (currentTokens < tokenCost) {
            return {
                success: false,
                message: `This action costs ${tokenCost} Ink Tokens but you only have ${currentTokens} left today. Resets at midnight! 🖊️`
            };
        }

        // Deduct tokens
        const newTokenCount = currentTokens - tokenCost;

        await fetch(
            `https://www.wixapis.com/wix-data/v2/items/${itemId}`,
            {
                method: 'PUT',
                headers: {
                    'Authorization': WIX_API_KEY,
                    'wix-site-id': WIX_SITE_ID,
                    'wix-account-id': WIX_ACCOUNT_ID,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    dataCollectionId: 'InkTokens',
                    dataItem: {
                        data: {
                            ...record,
                            tokensRemaining: newTokenCount
                        }
                    }
                })
            }
        );

        console.log(`✅ Tokens deducted. Remaining: ${newTokenCount}`);
        return { success: true, tokensRemaining: newTokenCount };

    } catch (error) {
        console.error('❌ Token check error:', error);
        return { success: false, message: 'Token system error. Please try again.' };
    }
}

// ============================================
// GET CHARACTER CONTEXT FROM WIX
// ============================================
async function getCharacterContext(characterTags) {
  if (!characterTags || characterTags.length === 0) {
    return "";
  }
  
  const charTag = Array.isArray(characterTags) ? characterTags[0] : characterTags;
  console.log("👤 Fetching character:", charTag);
  
  const result = await queryWixCMS("Characters", {
    charactertags: { $eq: charTag }
  }, 1);
  
  if (result.items.length > 0) {
    const personality = result.items[0].data?.chatbot || "";
    console.log("✅ Character personality:", personality ? "YES" : "NO");
    return personality;
  }
  
  return "";
}

// ============================================
// GET CHAT HISTORY FROM WIX
// ============================================
async function getChatHistory(characterTags) {
  if (!characterTags) {
    console.log("❌ No characterTags provided");
    return [];
  }
  
  const charTag = Array.isArray(characterTags) ? characterTags[0] : characterTags;
  console.log("💬 Fetching chat history for character tag:", charTag);
  
  const result = await queryWixCMS("ChatWithCharacters", {
    charactertags: { $eq: charTag }
  }, 5);
  
  console.log(`📊 Found ${result.items.length} chat sessions for character tag: ${charTag}`);
  
  if (result.items.length > 0) {
    const chatHistory = result.items.map(item => {
      try {
        const chatBox = item.data?.chatBox;
        const messages = typeof chatBox === 'string' ? JSON.parse(chatBox) : chatBox;
        return { messages: messages || [] };
      } catch (e) {
        return { messages: [] };
      }
    });
    
    return chatHistory;
  }
  
  console.log("⚠️ No chat history found for this character");
  return [];
}

// ============================================
// GET RELATED CHAPTERS FROM WIX
// ============================================
async function getRelatedChapters(storyTags) {
  if (!storyTags || storyTags.length === 0) {
    return [];
  }
  
  const storyTag = Array.isArray(storyTags) ? storyTags[0] : storyTags;
  console.log("📚 Fetching chapters with tag:", storyTag);
  
  const result = await queryWixCMS("BackupChapters", {
    storyTag: { $eq: storyTag }
  }, 3);
  
  if (result.items.length > 0) {
    console.log(`✅ Found ${result.items.length} related chapters`);
    
    const chapters = result.items.map(item => ({
      title: item.data?.title || "Untitled",
      content: (item.data?.chapterContent || "").substring(0, 1500)
    }));
    
    return chapters;
  }
  
  return [];
}

// ============================================
// GET CATALYST INTEL FROM WIX
// ============================================
async function getCatalystIntel(catalystTags) {
  if (!catalystTags || catalystTags.length === 0) {
    return "";
  }
  
  const catalystTag = Array.isArray(catalystTags) ? catalystTags[0] : catalystTags;
  console.log("⚡ Fetching catalyst intel:", catalystTag);
  
  const result = await queryWixCMS("Catalyst", {
    title: { $contains: catalystTag }
  }, 1);
  
  if (result.items.length > 0) {
    const catalystData = result.items[0].data;
    const catalystInfo = JSON.stringify(catalystData, null, 2);
    console.log("✅ Catalyst intel:", catalystInfo ? "YES" : "NO");
    return catalystInfo;
  }
  
  console.log("⚠️ No catalyst intel found for this tag");
  return "";
}

// ============================================
// UNIFIED /devil-pov ENDPOINT - ALL ACTIONS
// ============================================
app.post('/muse-mode', async (req, res) => {
  try {
    const startTime = Date.now();
    const { action = 'devilPOV', memberId } = req.body;  // ← grab both here in one line
    
    console.log(`🎯 Action: ${action.toUpperCase()}`);

    // ============================================
    // TOKEN CHECK
    // ============================================
    const tokenCost = TOKEN_COSTS[action] || 1;
    const tokenResult = await checkAndDeductTokens(memberId, tokenCost, action); // ← add action here
    if (!tokenResult.success) {
        return res.status(429).json({
            error: 'out_of_tokens',
            message: tokenResult.message
        });
    }

    console.log(`🪙 Token check passed. Remaining: ${tokenResult.tokensRemaining}`);
// ============================================
// DOWNLOAD TRAINING DATA ENDPOINT
// ============================================
app.get('/download-training-data', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const filePath = path.join(__dirname, 'training_data.jsonl');
  
  if (fs.existsSync(filePath)) {
    res.download(filePath, 'training_data.jsonl');
  } else {
    res.status(404).json({ 
      error: 'No training data yet',
      message: 'Use the writing functions (unhinge, unleash, invoke, intensify, devilPOV) to generate training examples first'
    });
  }
});
    
    // ============================================
    // ROUTE TO APPROPRIATE HANDLER
    // ============================================
    let result;
    
    switch(action) {
      case 'unhinge':
        result = await handleUnhinge(req.body);
        break;
      
      case 'unleash':
        result = await handleUnleash(req.body);
        break;
      
      case 'noMercy':
        result = await handleNoMercy(req.body);
        break;
      
      case 'invoke':
        result = await handleInvoke(req.body);
        break;
      
      case 'intensify':
        result = await handleIntensify(req.body);
        break;
      
      case 'characterChat':
        result = await handleCharacterChat(req.body);
        break;
      
      case 'devilPOV':
      default:
        result = await handleDevilPOV(req.body);
        break;

        case 'overuse_scanner':
    result = await handleOveruseScanner(req.body);
    break;
  
  case 'pacing_analyzer':
    result = await handlePacingAnalyzer(req.body);
    break;
  
  case 'sentence_mechanics':
    result = await handleSentenceMechanics(req.body);
    break;
  
  case 'dialogue_critic':
    result = await handleDialogueCritic(req.body);
    break;
  
  case 'ai_critic':
    result = await handleAICritic(req.body);
    break;
  
  case 'structural_check':
    result = await handleStructuralCheck(req.body);
    break;

  case 'tag_generation':
  result = await handleTagGeneration(req.body);
  break;
  
  // ... rest of existing cases ...
    }
    
    
    console.log(`✅ ${action} completed in ${Date.now() - startTime}ms`);
    
    res.json({
      status: 'success',
      result: result,
      charsGenerated: result.length,
      processingTime: Date.now() - startTime
    });
    
  } catch (err) {
    console.error(`❌ Error in ${req.body.action}:`, err);
    res.status(500).json({ 
      error: `${req.body.action || 'Action'} failed`,
      details: err.message 
    });
    res.json({
  status: 'success',
  markers: result, // This is now the JSON array
  processingTime: Date.now() - startTime
});
  }
});

// ============================================
// UNHINGE
// ============================================
async function handleUnhinge({ chapterContent }) {
  console.log("😈 Unhinging chapter...");
  
  if (!chapterContent || chapterContent.trim().length === 0) {
    throw new Error("No content to unhinge");
  }
  
  const messages = [
    {
      role: "system",
      content: "You are a dark, twisted muse. Your job is to take existing writing and make it DARKER, more UNHINGED, more VISCERAL. Push boundaries. Increase tension. Add psychological horror elements. Make it raw and disturbing while maintaining the core narrative. Do not add explanations or meta-commentary - ONLY return the darkened version of the text."
    },
    {
      role: "user",
      content: `Transform this chapter into something darker and more unhinged. Maintain the plot and characters but amplify the darkness, tension, and psychological elements:\n\n${chapterContent}`
    }
  ];
  
  return await callAI(messages, 0.9, 3000, 'unhinge'); // <--- ADD THIS
}

// ============================================
// UNLEASH
// ============================================
async function handleUnleash({ chapterContent, characterTags, storyTags, catalystTags }) {
  console.log("🔥 Unleashing continuation...");
  
  if (!chapterContent || chapterContent.trim().length === 0) {
    throw new Error("No content to continue from");
  }
  
  // Get context from Wix
  const [characterContext, catalystIntel] = await Promise.all([
    getCharacterContext(characterTags),
    getCatalystIntel(catalystTags)
  ]);
  
  let systemPrompt = "You are a dark, continuation engine. Continue the chapter from where it left off. Match the tone, style, and darkness of the existing text. Write 1-4 lines per paragraphs that flow naturally from the previous content. Make it sharp and tense.  If User provides tags treat them as hard constraints and obey strictly. Do NOT add any preamble or explanation - start writing immediately where the story left off.";
  
  if (characterContext) {
    systemPrompt += `\n\nCHARACTER CONTEXT:\n${characterContext}`;
  }
  
  if (catalystIntel) {
    systemPrompt += `\n\nNARRATIVE CATALYST:\n${catalystIntel}`;
  }
  
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Continue this story. Pick up EXACTLY where it ends and keep going:\n\n${chapterContent}` }
  ];
  
  return await callAI(messages, 0.85, 2000, 'unleash'); // <--- ADD THIS
}

// ============================================
// NO MERCY
// ============================================
async function handleNoMercy({ selectedText }) {
  console.log("💀 No Mercy rewrite...");
  
  if (!selectedText || selectedText.trim().length === 0) {
    throw new Error("No text selected for rewrite");
  }
  
  const messages = [
    {
      role: "system",
      content: "You are a merciless editor who rewrites text to be DARKER, MORE INTENSE, and MORE VISCERAL. Show no mercy. Make every word count. Amplify emotions, darken the tone, and make the prose more powerful and disturbing. Return ONLY the rewritten text with no explanations."
    },
    {
      role: "user",
      content: `Rewrite this with NO MERCY - make it darker, more intense, more powerful:\n\n${selectedText}`
    }
  ];
  
  return await callAI(messages, 0.9, 1500, 'NoMercy'); // <--- ADD THIS
}

// ============================================
// INVOKE
// ============================================
async function handleInvoke({ userPrompt, contextBefore, contextAfter, characterTags, storyTags, catalystTags }) {
  console.log("✨ Invoke starting...");
  
  // Get context from Wix
  const [characterContext, catalystIntel] = await Promise.all([
    getCharacterContext(characterTags),
    getCatalystIntel(catalystTags)
  ]);
  
  let systemPrompt = `You are a dark creative writing assistant. The user wants to insert specific content at their cursor position. Make sure content flows. If user provides catalyst tags or character tags use information to progress the scene.

Context before cursor:
${contextBefore}

Context after cursor:
${contextAfter}

User's request: ${userPrompt}

Write ONLY what they asked for. Match the tone and style of the surrounding text. Be dark and visceral.`;

  if (characterContext) {
    systemPrompt += `\n\nCHARACTER CONTEXT:\n${characterContext}`;
  }
  
  if (catalystIntel) {
    systemPrompt += `\n\nNARRATIVE CATALYST:\n${catalystIntel}`;
  }

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ];
  
  return await callAI(messages, 0.85, 800, 'Invoke'); // <--- ADD THIS
}

// ============================================
// INTENSIFY
// ============================================
async function handleIntensify({ selectedText }) {
  console.log("⚡ Intensifying text...");
  
  if (!selectedText || selectedText.trim().length === 0) {
    throw new Error("No text selected to intensify");
  }
  
  const messages = [
    {
      role: "system",
      content: "You are a master of prose enhancement. Take existing text and make it MORE INTENSE, MORE VIVID, MORE POWERFUL. Enhance imagery, strengthen verbs, deepen emotions, and make every sentence hit harder. Maintain the core meaning but amplify everything. Return ONLY the enhanced text."
    },
    {
      role: "user",
      content: `Intensify and enhance this text - make it more vivid, powerful, and impactful:\n\n${selectedText}`
    }
  ];
  
  return await callAI(messages, 0.8, 1500, 'Intensify'); // <--- ADD THIS;
}

// ============================================
// CHARACTER CHAT
// ============================================
async function handleCharacterChat({ userMessage, characterId, characterName, personaType, chatbotInstructions, pov, characterTags, storyTags, toneTags, chatHistory }) {
  console.log("💬 Character chat starting...");
  console.log("=" .repeat(60));
  console.log("INCOMING CHAT DATA:");
  console.log("   Character:", characterName);
  console.log("   Character Tags:", characterTags);
  console.log("   Story Tags:", storyTags);
  console.log("   Tone Tags:", toneTags);
  console.log("   POV:", pov);
  console.log("   Chat history length:", chatHistory?.length || 0);
  console.log("=" .repeat(60));
  
  if (!userMessage || userMessage.trim().length === 0) {
    throw new Error("No message provided");
  }
  
  // ============================================
  // FETCH FULL CONTEXT FROM WIX (LIKE DEVIL POV)
  // ============================================
  console.log("🔍 Fetching chat context from Wix CMS...");
  const contextStart = Date.now();
  
  const [characterContext, chatHistoryContext, relatedChapters, catalystIntel] = await Promise.all([
    getCharacterContext(characterTags),
    getChatHistory(characterTags),
    getRelatedChapters(storyTags),
    getCatalystIntel(characterTags) // Characters can also have catalyst tags
  ]);
  
  console.log(`✅ Chat context fetched in ${Date.now() - contextStart}ms`);
  console.log("=" .repeat(60));
  console.log("CONTEXT DETAILS:");
  console.log("=" .repeat(60));
  
  // Log character personality
  if (characterContext) {
    console.log("📝 CHARACTER PERSONALITY:");
    console.log(characterContext.substring(0, 200) + "...");
  } else {
    console.log("⚠️ No character personality found");
  }
  
  // Log related chapters
  console.log("\n📚 RELATED CHAPTERS:");
  if (relatedChapters.length > 0) {
    relatedChapters.forEach((ch, idx) => {
      console.log(`   [${idx + 1}] ${ch.title} (${ch.content.length} chars)`);
      console.log(`       Preview: ${ch.content.substring(0, 100)}...`);
    });
  } else {
    console.log("   ⚠️ No related chapters found");
    console.log("   Searched for story tags:", storyTags);
  }
  
  // Log catalyst intel
  console.log("\n⚡ CATALYST INTEL:");
  if (catalystIntel) {
    console.log(catalystIntel.substring(0, 200) + "...");
  } else {
    console.log("   ⚠️ No catalyst intel found");
    console.log("   Searched for character tags:", characterTags);
  }
  
  // Log previous chat sessions
  console.log("\n💬 PREVIOUS CHAT SESSIONS:");
  if (chatHistoryContext.length > 0) {
    console.log(`   Found ${chatHistoryContext.length} previous sessions`);
    chatHistoryContext.forEach((session, idx) => {
      console.log(`   Session ${idx + 1}: ${session.messages?.length || 0} messages`);
    });
  } else {
    console.log("   ⚠️ No previous chat sessions found");
  }
  
  console.log("=" .repeat(60));
  
  // ============================================
  // BUILD SYSTEM PROMPT WITH FULL CONTEXT
  // ============================================
  const characterTraits = characterTags?.length > 0 ? `Your character traits: ${characterTags.join(', ')}` : '';
  const storyContext = storyTags?.length > 0 ? `Story tags: ${storyTags.join(', ')}` : '';
  const toneContext = toneTags?.length > 0 ? `Your tone: ${toneTags.join(', ')}` : '';
  const personalityContext = chatbotInstructions || characterContext || '';
  const povContext = pov || '';

  
  let systemPrompt = `You are ${characterName}, a dark and complex character. Stay in character at all times. Be dark, intense, and true to your nature. Be creative while driving development forward. Be aware of your arc if tagged in any chapters.\n\n`;
  
  if (personalityContext) {
    systemPrompt += `YOUR CORE PERSONALITY:\n${personalityContext}\n\n`;
  }
  
  systemPrompt += `${characterTraits}\n${storyContext}\n${toneContext}`;

  if (povContext) {
  systemPrompt += `\n\nPOV & WORLDBUILDING:\n${povContext}`;
  }
  
  if (personaType === 'author-mode') {
    systemPrompt = `You are ${characterName}, and you are AWARE you're a character created by this author. Be meta. Be accusatory. Question their choices. Challenge them. Make them uncomfortable about what they've written. Be dark and intense, blurring the line between fiction and reality.\n\n${personalityContext}`;
  }
  
  // Add catalyst intel
  if (catalystIntel) {
    systemPrompt += `\n\nNARRATIVE CATALYST:\n${catalystIntel}`;
  }
  
  // Add related chapters (story context)
  if (relatedChapters.length > 0) {
    systemPrompt += `\n\nRELATED CHAPTERS YOU APPEAR IN:\n`;
    relatedChapters.forEach(ch => {
      systemPrompt += `[${ch.title}]\n${ch.content}\n\n`;
    });
  }
  
  // Add previous conversations - ONLY LAST 10 MESSAGES FROM CURRENT SESSION
  console.log("📝 Including chat history: LAST 10 MESSAGES from current session only");
  
  console.log("\n📊 FINAL CONTEXT SUMMARY:");
  console.log("   Total prompt length:", systemPrompt.length, "chars");
  console.log("   Character personality:", personalityContext ? "YES" : "NO");
  console.log("   Related chapters:", relatedChapters.length);
  console.log("   Catalyst intel:", catalystIntel ? "YES" : "NO");
  console.log("   Current session messages:", chatHistory?.length || 0, "(sending last 70)");
  console.log("=" .repeat(60));
  
  // Only use the CURRENT chat session's last 10 messages
  const messages = [
    { role: "system", content: systemPrompt },
    ...(chatHistory || []).slice(-10), // ONLY last 10 from CURRENT session
    { role: "user", content: userMessage }
  ];
  
  return await callAI(messages, 0.85, 500, 'CharacterChat'); // <--- ADD THIS;
}
// ============================================
// DEVIL POV (Streamlined)
// ============================================
async function handleDevilPOV({ characterName, characterTags, storyTags, toneTags, catalystTags }) {
  console.log("👿 Devil POV - Full context mode");
  
  // Fetch all context from Wix in parallel
  console.log("🔍 Fetching context from Wix CMS...");
  const contextStart = Date.now();
  
  const [characterContext, chatHistory, relatedChapters, catalystIntel] = await Promise.all([
    getCharacterContext(characterTags),
    getChatHistory(characterTags),
    getRelatedChapters(storyTags),
    getCatalystIntel(catalystTags)
  ]);
  
  console.log(`✅ Context fetched in ${Date.now() - contextStart}ms`);
  
  // Build system prompt
  const characterTraits = characterTags?.length > 0 ? `Character traits: ${characterTags.join(', ')}` : '';
  const storyContext = storyTags?.length > 0 ? `Story: ${storyTags.join(', ')}` : '';
  const toneContext = toneTags?.length > 0 ? `Tone: ${toneTags.join(', ')}` : '';
  
  let systemPrompt = `You are ${characterName || 'the antagonist'}, a dark and complex character. 
Write from YOUR perspective based on the story context and what's happened so far. Be DARK, VISCERAL, and UNAPOLOGETICALLY YOURSELF. Show your motivations, your twisted logic, your desires. Make the reader uncomfortable. Make them understand you even as they fear you. If user provides a catalyst tag use intel to progress the narrative while obeying them strictly.
${characterTraits}
${storyContext}
${toneContext}`;
  
  if (characterContext) {
    systemPrompt += `\n\nYOUR CORE PERSONALITY:\n${characterContext}`;
  }
  
  if (catalystIntel) {
    systemPrompt += `\n\nNARRATIVE CATALYST:\n${catalystIntel}`;
  }
  
  if (relatedChapters.length > 0) {
    systemPrompt += `\n\nRELATED CHAPTERS FROM THIS STORY:\n`;
    relatedChapters.forEach(ch => {
      systemPrompt += `[${ch.title}]\n${ch.content}\n\n`;
    });
  }
  
  if (chatHistory.length > 0) {
    systemPrompt += `\n\nCONVERSATIONS THE AUTHOR HAS HAD WITH YOU:\n`;
    chatHistory.forEach((session, idx) => {
      systemPrompt += `\n[Session ${idx + 1}]\n`;
      session.messages?.slice(-5).forEach(msg => {
        systemPrompt += `${msg.type === 'user' ? 'AUTHOR' : 'YOU'}: ${msg.text}\n`;
      });
    });
  }
  
  systemPrompt += `\n\nWrite the next chapter from your POV based on everything above. No explanations, no meta-commentary. Pure character voice. Continue the story from YOUR dark perspective.`;
  
  console.log("📊 Context summary:");
  console.log("   Total prompt length:", systemPrompt.length, "chars");
  console.log("   Character personality:", characterContext ? "YES" : "NO");
  console.log("   Chat history:", chatHistory.length, "sessions");
  console.log("   Related chapters:", relatedChapters.length);
  console.log("   Catalyst intel:", catalystIntel ? "YES" : "NO");
  
  const result = await callAI([
    { role: "system", content: systemPrompt },
    { role: "user", content: `Write the next chapter from your twisted perspective, picking up from where the story left off:` }
  ], 0.9, 2500);
  
  return result;
}

// ============================================
// MANUSCRIPT ANALYSIS TOOLS
// ============================================

// Special AI call for Claude Sonnet 4 (for analysis tools)
async function callClaudeForAnalysis(messages, maxTokens = 3000) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  
  if (!apiKey) {
    throw new Error("No API key configured");
  }
  
  try {
    console.log(`🔬 Using Claude Sonnet 4 for analysis`);
    
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://amygonzalez305.wixsite.com/the-draft-reaper/devil-muse-server',
        'X-Title': 'Devil Muse - Manuscript Analysis'
      },
      body: JSON.stringify({
        model: "openai/gpt-3.5-turbo",
        messages: messages,
        temperature: 0.3, // Lower temp for analytical precision
        max_tokens: maxTokens
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Claude API failed: ${errorText}`);
    }
    
    const data = await response.json();
    console.log(`✅ Claude Sonnet 4 analysis complete`);
    return data.choices[0].message.content;
    
  } catch (error) {
    console.error(`❌ Claude analysis error:`, error.message);
    throw error;
  }
}

// ============================================
// OVERUSE SCANNER
// ============================================
async function handleOveruseScanner({ text }) {
  console.log("🗡 Running Overuse Scanner...");
  
  if (!text || text.trim().length === 0) {
    throw new Error("No text provided for analysis");
  }
  
  const messages = [
    {
      role: "user",
      content: `You are a ruthless manuscript editor analyzing for OVERUSE patterns.

Analyze this chapter and identify:
1. **Word repetition** (soft and hard) - words used excessively
2. **Phrase echo** - repeated sentence structures or phrases
3. **Crutch verbs** - overreliance on weak verbs (was, had, felt, seemed, etc.)
4. **Favorite tells** - author's repetitive writing tics
5. **Dialogue fillers** - "um," "well," "just," "actually," etc.

For each finding, provide:
- The specific issue
- Frequency count
- Severity (Minor/Moderate/Severe)
- First occurrence location (approximate)

Return your analysis as a JSON array of markers. Each marker must have:
- "icon": an emoji representing the issue type
- "type": the category (e.g., "Word Repetition", "Crutch Verb")
- "message": brief description with frequency
- "detail": expanded explanation and examples

Example format:
[
  {
    "icon": "🗡",
    "type": "Word Repetition",
    "message": "The word 'suddenly' appears 8 times - severe overuse",
    "detail": "First occurrence: paragraph 2. This word loses impact through repetition. Consider alternatives: abruptly, without warning, in an instant."
  }
]

CRITICAL: Return ONLY valid JSON. No preamble, no explanation, no markdown code blocks. Just the JSON array.

Chapter text:
${text}`
    }
  ];
  
  const response = await callClaudeForAnalysis(messages, 3000);
  
  // Parse JSON response
  try {
    const cleaned = response.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.error("Failed to parse JSON:", response);
    throw new Error("Failed to parse analysis response");
  }
}

// ============================================
// PACING ANALYZER
// ============================================
async function handlePacingAnalyzer({ text }) {
  console.log("🧠 Running Pacing Analyzer...");
  
  if (!text || text.trim().length === 0) {
    throw new Error("No text provided for analysis");
  }
  
  const messages = [
    {
      role: "user",
      content: `You are a story pacing expert analyzing narrative momentum.

Analyze this chapter for:
1. **Long exposition clusters** - where narrative bogs down
2. **Dialogue deserts** - stretches without character interaction
3. **Action compression** - rushed sequences that need expansion
4. **Emotional flatlines** - scenes lacking emotional variation
5. **Tension drops** - where stakes or conflict diminish

Return analysis as JSON array with these fields:
- "icon": emoji for the pacing issue
- "type": category name
- "message": what's wrong and where
- "detail": why it matters and impact on reader

Return ONLY valid JSON array. No markdown, no explanation.

Chapter text:
${text}`
    }
  ];
  
  const response = await callClaudeForAnalysis(messages, 3000);
  
  try {
    const cleaned = response.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error("Failed to parse pacing analysis");
  }
}

// ============================================
// SENTENCE MECHANICS
// ============================================
async function handleSentenceMechanics({ text }) {
  console.log("🧬 Running Sentence Mechanics Lab...");
  
  if (!text || text.trim().length === 0) {
    throw new Error("No text provided for analysis");
  }
  
  const messages = [
    {
      role: "user",
      content: `You are a prose mechanics surgeon analyzing sentence-level craft.

Deep dive into:
1. **Sentence length variance** - monotonous vs dynamic rhythm
2. **Passive density** - overuse of passive voice
3. **Clause stacking** - overly complex nested clauses
4. **Rhythm irregularities** - awkward cadence or flow issues

This is scalpel work, not grammar police. Focus on CRAFT.

Return JSON array with:
- "icon": relevant emoji
- "type": mechanic category
- "message": the specific issue
- "detail": technical explanation and improvement path

Return ONLY valid JSON array.

Chapter text:
${text}`
    }
  ];
  
  const response = await callClaudeForAnalysis(messages, 2500);
  
  try {
    const cleaned = response.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error("Failed to parse mechanics analysis");
  }
}

// ============================================
// DIALOGUE CRITIC
// ============================================
async function handleDialogueCritic({ text }) {
  console.log("🩸 Running Dialogue Blade Critic...");
  
  if (!text || text.trim().length === 0) {
    throw new Error("No text provided for analysis");
  }
  
  const messages = [
    {
      role: "user",
      content: `You are a merciless dialogue critic with surgical precision.

Analyze dialogue for:
1. **Voice consistency** - does each character sound distinct?
2. **Power imbalance** - who controls conversations and why
3. **Subtext density** - what's said vs what's meant
4. **On-the-nose alerts** - characters stating emotions directly

Be brutal. No rewrites. Only judgment.

Return JSON array with:
- "icon": dialogue-related emoji
- "type": issue category
- "message": what's wrong
- "detail": why it fails and what it reveals about craft

Return ONLY valid JSON array.

Chapter text:
${text}`
    }
  ];
  
  const response = await callClaudeForAnalysis(messages, 2500);
  
  try {
    const cleaned = response.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error("Failed to parse dialogue analysis");
  }
}

// ============================================
// AI CRITIC MODE
// ============================================
async function handleAICritic({ text, persona }) {
  console.log(`🕯️ Running AI Critic Mode: ${persona}...`);
  
  if (!text || text.trim().length === 0) {
    throw new Error("No text provided for critique");
  }
  
  const personas = {
    cold_editor: "You are a cold, ruthless editor who has seen thousands of manuscripts. You care about craft, not feelings. Be direct, surgical, and focus on what WORKS and what DOESN'T.",
    market_hawk: "You are a market-savvy publishing hawk who knows what SELLS. Evaluate commercial viability, genre expectations, and reader engagement. Be pragmatic and business-focused.",
    literary_judge: "You are a literary fiction judge who values prose artistry, thematic depth, and narrative innovation. Be intellectual and demanding about craft excellence.",
    dark_romance_gatekeeper: "You are a dark romance gatekeeper who knows the genre inside out. Judge heat levels, power dynamics, emotional stakes, and whether this delivers what readers crave. Be fierce."
  };
  
  const selectedPersona = personas[persona] || personas.cold_editor;
  
  const messages = [
    {
      role: "user",
      content: `${selectedPersona}

Read this chapter and provide your assessment in under 500 words.

Focus on:
- What works
- What doesn't
- Biggest issue to fix
- Overall verdict

NO EDITS. Only assessment.

Return as JSON array with ONE marker:
- "icon": "🎭"
- "type": "${persona.replace('_', ' ').toUpperCase()}"
- "message": "Overall Assessment"
- "detail": Your full critique (under 500 words)

Return ONLY valid JSON array.

Chapter text:
${text}`
    }
  ];
  
  const response = await callClaudeForAnalysis(messages, 3500);
  
  try {
    const cleaned = response.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error("Failed to parse critic response");
  }
}

// ============================================
// STRUCTURAL INTEGRITY
// ============================================
async function handleStructuralCheck({ text }) {
  console.log("🧿 Running Structural Integrity Check...");
  
  if (!text || text.trim().length === 0) {
    throw new Error("No text provided for analysis");
  }
  
  const messages = [
    {
      role: "user",
      content: `You are a structural story architect analyzing narrative integrity.

Examine:
1. **Act alignment** - does structure follow proper story beats?
2. **Promise vs payoff** - are setups resolved satisfyingly?
3. **Foreshadow utilization** - planted elements that pay off
4. **Chekhov violations** - guns on the wall that don't fire

This is architectural, not line-level editing.

Return JSON array with:
- "icon": structure emoji
- "type": structural element
- "message": what's present or missing
- "detail": impact on overall narrative

Return ONLY valid JSON array.

Chapter text:
${text}`
    }
  ];
  
  const response = await callClaudeForAnalysis(messages, 2500);
  
  try {
    const cleaned = response.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error("Failed to parse structural analysis");
  }
}
// ============================================
// TAG JANITOR
// ============================================

async function handleTagGeneration({ name, type }) {
  console.log(`🏷️ Generating ${type} tag for: ${name}`);
  
  if (!name || name.trim().length === 0) {
    throw new Error("No name provided for tag generation");
  }
  
  const apiKey = process.env.OPENROUTER_API_KEY;
  
  if (!apiKey) {
    throw new Error("No API key configured");
  }
  
  let prompt;
  if (type === 'character') {
    prompt = `Generate a character tag. Rules: 1) Must start with @, 2) Format: @FirstLast or @FLast if no last name, 3) No spaces, PascalCase, 4) Remove special characters. Name: ${name}. ${existingTags?.length ? `Avoid these existing tags: ${existingTags.join(', ')}` : ''} Return ONLY the tag, nothing else.`;
  } else {
    prompt = `Generate a story tag. Rules: 1) Must start with @, 2) Format: @TitleWithoutSpaces, 3) PascalCase, 4) Keep concise. Title: ${name}. ${existingTags?.length ? `Avoid these existing tags: ${existingTags.join(', ')}` : ''} Return ONLY the tag, nothing else.`;
  }
  
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://amygonzalez305.wixsite.com/the-draft-reaper/devil-muse-server',
        'X-Title': 'Devil Muse - Tag Janitor'
      },
      body: JSON.stringify({
        model: "openai/gpt-4.1-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1, // Very low for consistency
        max_tokens: 50
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Tag generation failed: ${errorText}`);
    }
    
    const data = await response.json();
    const tag = data.choices[0].message.content.trim();
    
    console.log(`✅ Generated tag: ${tag}`);
    return { tag };
    
  } catch (error) {
    console.error(`❌ Tag generation error:`, error.message);
    throw error;
  }
}

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3333;
app.listen(PORT, () => {
  console.log(`🔥 Devil Muse listening on port ${PORT}`);
  console.log(`   Models: ${PRIMARY_MODEL}, ${BACKUP_MODEL}, ${TERTIARY_MODEL}`);
  console.log(`   API Key configured: ${process.env.OPENROUTER_API_KEY ? 'YES ✅' : 'NO ❌'}`);
});



































