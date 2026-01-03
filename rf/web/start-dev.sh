#!/bin/bash

# Combined dev server startup script
# Starts both the Python Flask backend and Vite frontend dev server

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RF_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(dirname "$RF_DIR")"

cd "$SCRIPT_DIR"

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     CCA Playground - Development Server Startup        ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check if Python backend is available
if ! command -v python3 &> /dev/null; then
    echo -e "${YELLOW}Warning: python3 not found. Backend will not start.${NC}"
    BACKEND_AVAILABLE=false
else
    BACKEND_AVAILABLE=true
fi

# Check if Node.js is available
if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}Error: node not found. Please install Node.js.${NC}"
    exit 1
fi

# Check if npm is available
if ! command -v npm &> /dev/null; then
    echo -e "${YELLOW}Error: npm not found. Please install npm.${NC}"
    exit 1
fi

# Function to cleanup on exit
cleanup() {
    echo ""
    echo -e "${YELLOW}Shutting down servers...${NC}"
    if [ ! -z "$BACKEND_PID" ]; then
        kill $BACKEND_PID 2>/dev/null || true
    fi
    if [ ! -z "$FRONTEND_PID" ]; then
        kill $FRONTEND_PID 2>/dev/null || true
    fi
    exit 0
}

trap cleanup SIGINT SIGTERM

# Start Python backend
if [ "$BACKEND_AVAILABLE" = true ]; then
    echo -e "${GREEN}Starting Python backend on port 8080...${NC}"
    cd "$RF_DIR"
    python3 esp32_controller.py serve --port 8080 > /tmp/cca-backend.log 2>&1 &
    BACKEND_PID=$!
    echo -e "  Backend PID: ${BLUE}$BACKEND_PID${NC}"
    
    # Wait a moment for backend to start
    sleep 2
    
    # Check if backend started successfully
    if ! kill -0 $BACKEND_PID 2>/dev/null; then
        echo -e "${YELLOW}Warning: Backend may have failed to start. Check /tmp/cca-backend.log${NC}"
    else
        echo -e "${GREEN}✓ Backend running at http://localhost:8080${NC}"
    fi
    echo ""
fi

# Start Vite frontend
echo -e "${GREEN}Starting Vite dev server on port 5173...${NC}"
cd "$SCRIPT_DIR"

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}Installing dependencies...${NC}"
    npm install
fi

npm run dev > /tmp/cca-frontend.log 2>&1 &
FRONTEND_PID=$!
echo -e "  Frontend PID: ${BLUE}$FRONTEND_PID${NC}"

# Wait a moment for frontend to start
sleep 3

# Check if frontend started successfully
if ! kill -0 $FRONTEND_PID 2>/dev/null; then
    echo -e "${YELLOW}Warning: Frontend may have failed to start. Check /tmp/cca-frontend.log${NC}"
else
    echo -e "${GREEN}✓ Frontend running at http://localhost:5173${NC}"
fi

echo ""
echo -e "${BLUE}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║                    Servers Running                       ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Frontend: ${GREEN}http://localhost:5173${NC}"
if [ "$BACKEND_AVAILABLE" = true ]; then
    echo -e "  Backend:  ${GREEN}http://localhost:8080${NC}"
fi
echo ""
echo -e "${YELLOW}Press Ctrl+C to stop all servers${NC}"
echo ""

# Wait for processes
wait

