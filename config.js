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
       "mercury": {
      "type": "openai_compatible",
      "chat_endpoint": "https://api.inceptionlabs.ai/v1/chat/completions"
    },
        "apmix": {
      "type": "openai_compatible",
      "chat_endpoint": "https://api.apmix.ai/v1/chat/completions"
    },
      "nararouter": {
      "type": "openai_compatible",
      "chat_endpoint": "https://router.bynara.id/v1/chat/completions"
    }
    
  },
  
  "models": [
    { "name": "Google *gemini-3.8-flash", "id": "gemini-3.8-flash", "provider": "google", "capability": "chat", "rps": 0.25 },
 
    { "name": "Openr *gpt-5.4-mini", "id": "openai/gpt-5.4-mini", "provider": "openrouter", "capability": "chat", "rps": null },
       
    { "name": "Groq *gpt-oss-120b", "id": "openai/gpt-oss-120b", "provider": "groq", "capability": "chat", "rps": 0.5 },
    
     { "name": "Nara *combo/nemo", "id": "combo/nemo", "provider": "nararouter", "capability": "chat", "rps": null },
    
   { "name": "Mercury *mercury-3", "id": "mercury-3", "provider": "mercury", "capability": "chat", "rps": 1 },
   
   { "name": "Apmix *claude-sonnet-4-6-free", "id": "claude-sonnet-4-6-free", "provider": "apmix", "capability": "chat", "rps":null }
   
  ]
};

export default config;
