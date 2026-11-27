# crosstalk window

The chat window that `crosstalk ui` opens: React, shadcn and assistant-ui. It builds into `../ui`, which the
daemon serves; the built files are committed, so crosstalk itself needs no install step.

```bash
npm install
npm run dev     # http://localhost:5173/#<token>, API proxied to a daemon on 127.0.0.1:4477
npm run build   # writes ../ui
```

The token is the part after `#` in the link `crosstalk ui` prints.
