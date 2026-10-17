# diagrams setup
npm i -D quick-erd
npx sqlite-to-erd file.db > file.txt
npx erd-ui aaa.txt

# path setup
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
    
const __dirname = dirname(fileURLToPath(import.meta.url));