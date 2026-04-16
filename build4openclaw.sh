#! /bin/sh
# sudo systemctl daemon-reload; 
# sudo systemctl restart ollama; 
# openclaw daemon stop; 
cd "$(dirname "$0")/openclaw-plugin"
npm install @sinclair/typebox
npm install typescript
npm install --save-dev @types/node
npm install;  
npm run build; 
openclaw plugins uninstall clawpyter; 
openclaw plugins install -l `pwd`; 
# openclaw daemon restart

# openclaw daemon restart

