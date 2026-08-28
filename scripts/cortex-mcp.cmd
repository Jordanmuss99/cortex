@echo off
rem Launcher for the CORTEX MCP stdio server.
rem Sets cwd to the repo root so dotenv loads .env, then execs tsx.
cd /d "%~dp0.."
"%~dp0..\node_modules\.bin\tsx.cmd" src\mcp\server.ts
