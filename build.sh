#!/bin/sh
# Rebuilds index.html (the public website) from app.html. Run: sh build.sh
cd "$(dirname "$0")"
ICON='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Crect width=%2232%22 height=%2232%22 rx=%229%22 fill=%22%23111210%22/%3E%3Cpath d=%22M8 10l6.2 13h1.6L22 10%22 fill=%22none%22 stroke=%22%23fbfbf9%22 stroke-width=%223.4%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22/%3E%3Ccircle cx=%2225%22 cy=%2222%22 r=%222.4%22 fill=%22%232bd98a%22/%3E%3C/svg%3E'
{
printf '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
printf '<meta name="description" content="One question a day for the whole planet. Answer in ten seconds, then see how the world answered.">\n'
printf '<meta property="og:title" content="Verd: what does the world think today?">\n'
printf '<meta property="og:description" content="What&#39;s the Verd? One question a day for everyone on Earth. Answer in 10 seconds, then see the world&#39;s verdict.">\n'
printf '<meta property="og:type" content="website"><meta name="twitter:card" content="summary"><meta name="theme-color" content="#fbfbf9">\n'
printf '<link rel="icon" href="%s">\n' "$ICON"
printf '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%%}[hidden]{display:none!important}</style>\n</head><body>\n'
grep -v 'claude:viewport-fit-sides' app.html
printf '\n</body></html>\n'
} > index.html
