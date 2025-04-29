# Chatbot de WhatsApp con GPT-4o mini

Este proyecto es un chatbot simple que utiliza la API de OpenAI (GPT-4o mini) y Twilio para responder mensajes de WhatsApp.

## Requisitos previos

- Node.js instalado
- Cuenta de OpenAI con API key
- Cuenta de Twilio con número de WhatsApp habilitado

## Instalación

1. Clona este repositorio:
```bash
git clone <url-del-repositorio>
cd whatsapp-gpt-chatbot
```

2. Instala las dependencias:
```bash
npm install
```

3. Crea un archivo `.env` en la raíz del proyecto con las siguientes variables:
```
# OpenAI API Keys
OPENAI_API_KEY=tu_clave_api_de_openai

# Twilio Credentials
TWILIO_ACCOUNT_SID=tu_account_sid_de_twilio
TWILIO_AUTH_TOKEN=tu_auth_token_de_twilio
TWILIO_PHONE_NUMBER=tu_numero_de_whatsapp_de_twilio
```

## Configuración de Twilio

1. Regístrate en [Twilio](https://www.twilio.com/) y obtén un número con capacidad de WhatsApp
2. En tu panel de Twilio, configura el webhook para mensajes entrantes:
   - URL: `https://tu-dominio.com/whatsapp` (reemplaza con tu dominio)
   - Método: POST

Si estás trabajando en modo de desarrollo, puedes usar [ngrok](https://ngrok.com/) para exponer tu servidor local a internet:
```bash
ngrok http 3000
```

## Ejecutar el proyecto

Desarrollo:
```bash
npm run dev
```

Producción:
```bash
npm start
```

## Uso

Una vez que todo esté configurado, los usuarios pueden enviar mensajes al número de WhatsApp proporcionado por Twilio y recibirán respuestas generadas por GPT-4o mini. 