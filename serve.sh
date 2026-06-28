#!/usr/bin/env sh
# Servidor local simple para la app (sin backend, sin nube).
# Uso típico en Termux (Android):  sh serve.sh   →  http://localhost:8080
#
# getUserMedia y los sensores requieren un "contexto seguro": http://localhost
# cuenta como seguro, así que abrir la app EN EL PROPIO dispositivo funciona.
# Para abrirla desde otro equipo necesitarás HTTPS (usa un túnel/reverse-proxy
# TLS o sirve los archivos por https).
PORT="${1:-8080}"
echo "Sirviendo AI Driving HUD en http://localhost:${PORT}"
if command -v python3 >/dev/null 2>&1; then
  exec python3 -m http.server "${PORT}"
elif command -v python >/dev/null 2>&1; then
  exec python -m http.server "${PORT}"
else
  echo "No se encontró Python. Instala python o usa otro servidor estático." >&2
  exit 1
fi
