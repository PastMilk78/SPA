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
 * Endpoint para procesar un chat específico
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Verificación simple de autenticación
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  
  // Obtener chatId del query parameter
  const { chatId } = req.query
  
  if (!chatId || Array.isArray(chatId)) {
    return res.status(400).json({ error: 'Invalid chatId parameter' })
  }
  
  try {
    console.log(`[PROCESS] Procesando chat: ${chatId}`);
    const { conversationsCollection } = await connectToDatabase();
    
    // Obtener mensajes en estado "processing" para este chat
    const messagesToProcess = await conversationsCollection.find({
      chatId: parseInt(chatId),
      status: "processing"
    }).sort({ timestamp: 1 }).toArray();
    
    if (messagesToProcess.length === 0) {
      console.log(`[PROCESS] No hay mensajes en estado 'processing' para chatId ${chatId}`);
      return res.status(200).json({ message: 'No messages to process' });
    }
    
    // Obtener mensajes históricos para contexto
    const historyMessages = await conversationsCollection.find({
      chatId: parseInt(chatId),
      status: "processed",
      timestamp: { $gte: new Date(Date.now() - 30 * 60 * 1000) } // 30 minutos
    }).sort({ timestamp: -1 }).limit(15).toArray();
    
    console.log(`[PROCESS] Recuperados ${messagesToProcess.length} mensajes para procesar y ${historyMessages.length} para contexto`);
    
    // Llamar a la función de procesamiento exportada por telegram.ts
    const telegramModule = await import('../telegram');
    
    const success = await telegramModule.processConversationFromCron(
      parseInt(chatId),
      messagesToProcess,
      historyMessages
    );
    
    if (success) {
      res.status(200).json({ success: true, message: `Procesados ${messagesToProcess.length} mensajes para chatId ${chatId}` });
    } else {
      res.status(500).json({ success: false, message: 'Error durante el procesamiento' });
    }
    
  } catch (error) {
    console.error(`[PROCESS] Error procesando chat ${chatId}:`, error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
} 