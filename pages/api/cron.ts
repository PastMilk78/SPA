import type { NextApiRequest, NextApiResponse } from 'next'
import { MongoClient, Db, Collection } from 'mongodb'
import TelegramBot from 'node-telegram-bot-api'

// --- MongoDB Connection --- 
const MONGODB_URI = process.env.MONGODB_URI
const DB_NAME = 'telegramBot'
const COLLECTION_NAME = 'temporalConversations'

if (!MONGODB_URI) {
  throw new Error('Please define the MONGODB_URI environment variable')
}

let client: MongoClient
let db: Db
let conversationsCollection: Collection<any>

async function connectToDatabase() {
  if (client && db) {
    return { client, db, conversationsCollection }
  }
  
  if (typeof MONGODB_URI !== 'string') {
    console.error('MongoDB URI is not defined or not a string.');
    throw new Error('MongoDB URI misconfigured');
  }
  
  try {
    client = new MongoClient(MONGODB_URI)
    await client.connect()
    db = client.db(DB_NAME)
    conversationsCollection = db.collection(COLLECTION_NAME)
    console.log('Connected to MongoDB!')
    return { client, db, conversationsCollection }
  } catch (error) {
    console.error('Failed to connect to MongoDB', error)
    throw error
  }
}

// Inicializar el bot con el token
const token = process.env.TELEGRAM_BOT_TOKEN
if (!token) {
  throw new Error('TELEGRAM_BOT_TOKEN is not defined')
}

// Crear una instancia del bot con el token
const bot = new TelegramBot(token, { polling: false })

/**
 * Endpoint para procesar mensajes pendientes mediante cron job
 * Se ejecuta cada minuto automáticamente
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // NOTA: Para trabajos cron integrados en Vercel, no es necesaria autenticación
  // ya que Vercel los ejecuta internamente de forma segura
  // Si alguien intenta llamar a este endpoint manualmente, la autenticación debería ocurrir
  let isVercelCron = false;
  
  try {
    // Verificar si es una llamada de Vercel Cron
    const userAgent = req.headers['user-agent'] || '';
    if (userAgent.includes('VercelCron')) {
      isVercelCron = true;
    }
    
    // Si no es llamada desde Vercel Cron, verificar la autenticación
    if (!isVercelCron) {
      const authHeader = req.headers.authorization;
      if (!authHeader || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    console.log('[CRON] Iniciando verificación de mensajes pendientes...');
    const { conversationsCollection } = await connectToDatabase();
    
    // 1. Encontrar chats con mensajes en espera cuyo tiempo ya pasó
    const now = new Date();
    const readyMessages = await conversationsCollection.find({
      waitingForDelay: true,
      waitUntil: { $lte: now }
    }).toArray();
    
    // Agrupar por chatId para procesamiento por chat
    const chatGroups: {[key: string]: any[]} = {};
    for (const msg of readyMessages) {
      const chatId = msg.chatId;
      if (!chatGroups[chatId]) {
        chatGroups[chatId] = [];
      }
      chatGroups[chatId].push(msg);
    }
    
    const chatsToProcess = Object.keys(chatGroups);
    console.log(`[CRON] Encontrados ${readyMessages.length} mensajes listos para procesar en ${chatsToProcess.length} chats`);
    
    if (chatsToProcess.length === 0) {
      return res.status(200).json({ 
        success: true, 
        message: 'No pending messages ready for processing' 
      });
    }
    
    // 2. Procesar cada chat
    let processedChats = 0;
    let failedChats = 0;
    
    for (const chatId of chatsToProcess) {
      try {
        console.log(`[CRON] Procesando mensajes para chatId: ${chatId}`);
        
        // Marcar todos los mensajes pendientes como "processing"
        const result = await conversationsCollection.updateMany(
          { 
            chatId: parseInt(chatId), 
            waitingForDelay: true,
            waitUntil: { $lte: now }
          },
          { $set: { status: "processing", waitingForDelay: false, waitUntil: null } }
        );
        
        if (result.modifiedCount === 0) {
          console.log(`[CRON] No se encontraron mensajes para actualizar en el chat ${chatId}`);
          continue;
        }
        
        console.log(`[CRON] Marcados ${result.modifiedCount} mensajes como "processing"`);
        
        // Obtener todos los mensajes a procesar
        const messagesToProcess = await conversationsCollection.find({
          chatId: parseInt(chatId),
          status: "processing"
        }).sort({ timestamp: 1 }).toArray();
        
        if (messagesToProcess.length === 0) {
          console.log(`[CRON] No se encontraron mensajes para procesar para el chat ${chatId}`);
          continue;
        }

        console.log(`[CRON] Procesando ${messagesToProcess.length} mensajes para el chat ${chatId}`);
        
        // Obtener mensajes históricos para contexto
        const cutoffDate = new Date(now.getTime() - 30 * 60 * 1000); // 30 minutos
        const historyMessages = await conversationsCollection.find({
          chatId: parseInt(chatId),
          status: "processed",
          timestamp: { $gte: cutoffDate }
        }).sort({ timestamp: -1 })
        .limit(15)
        .toArray();
        
        console.log(`[CRON] Preparando contenido con ${messagesToProcess.length} mensajes nuevos y ${historyMessages.length} históricos`);
        
        // Importar y usar las funciones desde telegram.ts
        const telegramModule = await import('./telegram');
        const success = await telegramModule.processConversationFromCron(
          parseInt(chatId), 
          messagesToProcess, 
          historyMessages
        );
        
        if (success) {
          processedChats++;
        } else {
          failedChats++;
        }
        
      } catch (chatError) {
        console.error(`[CRON] Error procesando chat ${chatId}:`, chatError);
        failedChats++;
      }
    }
    
    console.log(`[CRON] Procesamiento completado. Éxitos: ${processedChats}, Fallos: ${failedChats}`);
    
    res.status(200).json({ 
      success: true, 
      processedChats: processedChats,
      failedChats: failedChats,
      totalMessages: readyMessages.length
    });
  } catch (error) {
    console.error('[CRON] Error en el cron job:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
} 