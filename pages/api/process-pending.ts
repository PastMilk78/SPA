import type { NextApiRequest, NextApiResponse } from 'next'
import { MongoClient, Db, Collection } from 'mongodb'

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

/**
 * Endpoint para forzar el procesamiento de mensajes pendientes
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    console.log('[MANUAL] Iniciando procesamiento manual de mensajes pendientes...');
    const { conversationsCollection } = await connectToDatabase();
    
    // Encontrar mensajes que están esperando y ya pasó su tiempo
    const now = new Date();
    const pendingMessages = await conversationsCollection.find({
      waitingForDelay: true,
      waitUntil: { $lte: now }
    }).toArray();
    
    // Agrupar por chatId
    const chatGroups: {[key: string]: any[]} = {};
    for (const msg of pendingMessages) {
      const chatId = msg.chatId;
      if (!chatGroups[chatId]) {
        chatGroups[chatId] = [];
      }
      chatGroups[chatId].push(msg);
    }
    
    const chatsToProcess = Object.keys(chatGroups);
    console.log(`[MANUAL] Encontrados ${pendingMessages.length} mensajes pendientes en ${chatsToProcess.length} chats`);
    
    // Para cada chat, marcar los mensajes como "processing"
    for (const chatId of chatsToProcess) {
      const messageIds = chatGroups[chatId].map(m => m._id);
      await conversationsCollection.updateMany(
        { _id: { $in: messageIds } },
        { $set: { status: "processing", waitingForDelay: false, waitUntil: null } }
      );
      
      // Llamar al endpoint de telegram para procesar
      try {
        const result = await fetch(`${req.headers.host}/api/telegram/process?chatId=${chatId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.API_SECRET_KEY || 'default-secret'}`
          }
        });
        
        if (!result.ok) {
          console.error(`[MANUAL] Error procesando chat ${chatId}: ${result.statusText}`);
        }
      } catch (fetchError) {
        console.error(`[MANUAL] Error llamando al endpoint de procesamiento para chat ${chatId}:`, fetchError);
      }
    }
    
    res.status(200).json({ 
      success: true, 
      message: `Programado procesamiento para ${chatsToProcess.length} chats con ${pendingMessages.length} mensajes pendientes` 
    });
    
  } catch (error) {
    console.error('[MANUAL] Error en el procesamiento manual:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
} 