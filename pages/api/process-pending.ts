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
 * Accesible desde el navegador para procesamiento manual
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Permitir acceso desde el navegador para depuración
  // IMPORTANTE: En producción, esto debería tener autenticación
  try {
    console.log('[MANUAL] Iniciando procesamiento manual de mensajes pendientes...');
    const { conversationsCollection } = await connectToDatabase();
    
    // Encontrar mensajes que están esperando y ya pasó su tiempo
    const now = new Date();
    const pendingMessages = await conversationsCollection.find({
      waitingForDelay: true,
      waitUntil: { $lte: now }
    }).toArray();
    
    if (pendingMessages.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No hay mensajes pendientes listos para procesar'
      });
    }
    
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
    
    // Resultado HTML para mostrar en el navegador
    let resultHtml = `
    <html>
    <head>
      <title>Procesamiento de Mensajes</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; line-height: 1.6; }
        h1 { color: #333; }
        .info { background-color: #e6f7ff; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
        .success { background-color: #f6ffed; border: 1px solid #b7eb8f; padding: 10px; margin: 5px 0; border-radius: 3px; }
        .error { background-color: #fff1f0; border: 1px solid #ffa39e; padding: 10px; margin: 5px 0; border-radius: 3px; }
        .processing { background-color: #fffbe6; border: 1px solid #ffe58f; padding: 10px; margin: 5px 0; border-radius: 3px; }
        pre { background: #f5f5f5; padding: 10px; overflow: auto; }
      </style>
    </head>
    <body>
      <h1>Procesamiento Manual de Mensajes</h1>
      <div class="info">
        <p>Encontrados ${pendingMessages.length} mensajes pendientes en ${chatsToProcess.length} chats.</p>
      </div>
    `;
    
    // Para cada chat, marcar los mensajes como "processing"
    let processedChats = 0;
    let attemptedChats = 0;
    
    // Procesamos cada chat
    for (const chatId of chatsToProcess) {
      try {
        resultHtml += `<div class="processing">Procesando chat ${chatId}...</div>`;
        attemptedChats++;
        
        const messageIds = chatGroups[chatId].map(m => m._id);
        await conversationsCollection.updateMany(
          { _id: { $in: messageIds } },
          { $set: { status: "processing", waitingForDelay: false, waitUntil: null } }
        );
        
        // Obtener mensajes a procesar
        const messagesToProcess = await conversationsCollection.find({
          chatId: parseInt(chatId),
          status: "processing"
        }).sort({ timestamp: 1 }).toArray();
        
        // Obtener historial
        const historyMessages = await conversationsCollection.find({
          chatId: parseInt(chatId),
          status: "processed",
          timestamp: { $gte: new Date(Date.now() - 30 * 60 * 1000) } // 30 minutos
        }).sort({ timestamp: -1 }).limit(15).toArray();
        
        // Importar módulo de telegram y procesar conversación
        const telegramModule = await import('./telegram');
        const success = await telegramModule.processConversationFromCron(
          parseInt(chatId),
          messagesToProcess,
          historyMessages
        );
        
        if (success) {
          processedChats++;
          resultHtml += `<div class="success">Chat ${chatId} procesado con éxito (${messagesToProcess.length} mensajes)</div>`;
        } else {
          resultHtml += `<div class="error">Error al procesar chat ${chatId}</div>`;
        }
      } catch (chatError: any) {
        console.error(`[MANUAL] Error procesando chat ${chatId}:`, chatError);
        resultHtml += `<div class="error">Error al procesar chat ${chatId}: ${chatError.message}</div>`;
      }
    }
    
    resultHtml += `
      <div class="info">
        <p>Completado: ${processedChats} de ${attemptedChats} chats procesados correctamente.</p>
        <p><a href="javascript:window.location.reload()">Actualizar</a></p>
      </div>
    </body>
    </html>`;
    
    // Si es una solicitud desde el navegador, devolver HTML
    if (req.headers.accept && req.headers.accept.includes('text/html')) {
      res.setHeader('Content-Type', 'text/html');
      res.status(200).send(resultHtml);
    } else {
      // Si es una API request, devolver JSON
      res.status(200).json({
        success: true,
        processedChats: processedChats,
        totalChats: chatsToProcess.length,
        totalMessages: pendingMessages.length
      });
    }
    
  } catch (error: any) {
    console.error('[MANUAL] Error en el procesamiento manual:', error);
    
    // Si es una solicitud desde el navegador, devolver HTML con error
    if (req.headers.accept && req.headers.accept.includes('text/html')) {
      res.setHeader('Content-Type', 'text/html');
      res.status(500).send(`
        <html>
          <head><title>Error</title><style>body{font-family:Arial;margin:20px;}</style></head>
          <body>
            <h1>Error</h1>
            <p>Ocurrió un error al procesar los mensajes: ${error.message}</p>
            <p><a href="javascript:window.location.reload()">Intentar de nuevo</a></p>
          </body>
        </html>
      `);
    } else {
      // Si es una API request, devolver JSON con error
      res.status(500).json({ 
        error: 'Error interno del servidor',
        message: error.message
      });
    }
  }
} 