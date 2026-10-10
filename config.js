const config = {
  "providers": {
    "google": {
      "type": "google",
      "chat_endpoint": "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
    },
       "groq": {
      "type": "openai_compatible",
      "chat_endpoint": "https://api.groq.com/openai/v1/chat/completions"
    },
    "openrouter": {
      "type": "openai_compatible",
      "chat_endpoint": "https://openrouter.ai/api/v1/chat/completions"
    },
       "cleanapis": {
      "type": "openai_compatible",
      "chat_endpoint": "https://cleanapis.com/v1/chat/completions"
    }

  },
  
  "models": [
    { "name": "Google * gemini-3.8-flash", "id": "gemini-3.8-flash", "provider": "google", "capability": "chat", "rps": 0.25 },
 
    { "name": "Openrouter * gpt-5.4-mini", "id": "openai/gpt-5.4-mini", "provider": "openrouter", "capability": "chat", "rps": null },
       
    { "name": "Groq * gpt-oss-120b", "id": "openai/gpt-oss-120b", "provider": "groq", "capability": "chat", "rps": 0.5 },
    
   { "name": "Cleanapis * gemini-3.7-flash", "id": "gemini-3.7-flash", "provider": "cleanapis", "capability": "chat", "rps": 1 },
   
   { "name": "Cleanapis * claude-sonnet-5", "id": "claude-sonnet-5", "provider": "cleanapis", "capability": "chat", "rps": 1 }
   
  ]
};

export default config;
