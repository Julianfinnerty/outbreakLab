@echo off
rem OutbreakLab: starts the local server (Level II writer + GR2Analyst polling) and opens the app.
cd /d "%~dp0"
start "" http://127.0.0.1:8820/
python server.py 8820
pause
