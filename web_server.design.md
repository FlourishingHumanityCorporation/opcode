# Opcode Web Server Design

This document describes the implementation of Opcode's web server mode, which allows access to provider sessions from mobile devices and browsers while maintaining full functionality.

## Overview

The web server provides a REST API and WebSocket interface that mirrors the Tauri desktop app's functionality, enabling phone/browser access to provider sessions.

## Architecture

```
┌─────────────────┐    WebSocket     ┌─────────────────┐    Process     ┌─────────────────┐
│   Browser UI    │ ←──────────────→ │  Rust Backend   │ ────────────→  │ Provider Binary │
│                 │    REST API      │   (Axum Server) │               │                 │
│ • React/TS      │ ←──────────────→ │                 │               │ • provider CLI  │
│ • WebSocket     │                  │ • Session Mgmt  │               │ • Subprocess    │
│ • DOM Events    │                  │ • Process Spawn │               │ • Stream Output │
└─────────────────┘                  └─────────────────┘               └─────────────────┘
```

## Key Components

### 1. Rust Web Server (`src-tauri/src/web_server.rs`)

**Main Functions:**
- `create_web_server()` - Sets up Axum server with routes
- `provider_session_websocket_handler()` - Manages WebSocket connections
- `execute_provider_session_command()` / `continue_provider_session_command()` / `resume_provider_session_command()` - Execute provider session processes
- `find_claude_binary_web()` - Locates Claude binary (bundled or system)

**Key Features:**
- **WebSocket Streaming**: Real-time output from provider processes
- **Session Management**: Tracks active WebSocket sessions
- **Process Spawning**: Launches provider subprocesses with proper arguments
- **Comprehensive Logging**: Detailed trace output for debugging

### 2. Frontend Event Handling (`src/components/ProviderSessionPane.tsx`)

**Dual Mode Support:**
```typescript
const listen = tauriListen || ((eventName: string, callback: (event: any) => void) => {
  // Web mode: Use DOM events
  const domEventHandler = (event: any) => {
    callback({ payload: event.detail });
  };
  window.addEventListener(eventName, domEventHandler);
  return Promise.resolve(() => window.removeEventListener(eventName, domEventHandler));
});
```

**Message Processing:**
- Handles both string payloads (Tauri) and object payloads (Web)
- Maintains compatibility with existing UI components
- Comprehensive error handling and logging

### 3. WebSocket Communication (`src/lib/apiAdapter.ts`)

**Request Format:**
```json
{
  "command_type": "execute|continue|resume",
  "project_path": "/path/to/project",
  "prompt": "user prompt",
  "model": "sonnet|opus",
  "session_id": "uuid-for-resume"
}
```

**Response Format:**
```json
{
  "type": "start|output|completion|error",
  "content": "parsed provider message",
  "message": "status message",
  "status": "success|error|cancelled"
}
```

## Message Flow

### 1. Prompt Submission
```
Browser → WebSocket Request → Rust Backend → Provider Process
```

### 2. Streaming Response
```
Provider Process → Rust Backend → WebSocket → Browser DOM Events → UI Update
```

### 3. Event Chain
1. **User Input**: Prompt submitted via FloatingPromptInput
2. **WebSocket Send**: JSON request sent to `/ws/provider-session`
3. **Process Spawn**: Rust spawns provider subprocess
4. **Stream Parse**: Stdout lines parsed and wrapped in JSON
5. **Event Dispatch**: DOM events fired for `provider-session-output`
6. **UI Update**: React components receive and display messages

## File Structure

```
opcode/
├── src-tauri/src/
│   └── web_server.rs           # Main web server implementation
├── src/
│   ├── lib/
│   │   └── apiAdapter.ts       # WebSocket client & environment detection
│   └── components/
│       ├── ProviderSessionPane.tsx           # Main session component
│       └── provider-session-pane/
│           └── sessionEventBus.ts          # Session event normalization helpers
└── justfile                    # Build configuration (just web)
```

## Build & Deployment

### Development
```bash
nix-shell --run 'just web'
# Builds frontend and starts Rust server on port 8080
```

### Production Considerations
- **Binary Location**: Checks bundled binary first, falls back to system PATH
- **CORS**: Configured for phone browser access
- **Error Handling**: Comprehensive logging and graceful failures
- **Session Cleanup**: Proper WebSocket session management

## Debugging Features

### Comprehensive Tracing
- **Backend**: All WebSocket events, process spawning, and message forwarding
- **Frontend**: Event setup, message parsing, and UI updates
- **Process**: Claude binary execution and output streaming

### Debug Output Examples
```
[TRACE] WebSocket handler started - session_id: uuid
[TRACE] Successfully parsed request: {...}
[TRACE] Claude process spawned successfully
[TRACE] Forwarding message to WebSocket: {...}
[TRACE] DOM event received: provider-session-output {...}
[TRACE] handleStreamMessage - message type: assistant
```

## Key Fixes Implemented

### 1. Event Handling Compatibility
**Problem**: Original code only worked with Tauri events
**Solution**: Enhanced `listen` function to support DOM events in web mode

### 2. Message Format Mismatch  
**Problem**: Backend sent JSON strings, frontend expected parsed objects
**Solution**: Parse `content` field in WebSocket handler before dispatching events

### 3. Process Integration
**Problem**: Web mode lacked Claude binary execution
**Solution**: Full subprocess spawning with proper argument passing and output streaming

### 4. Session Management
**Problem**: No state tracking for multiple concurrent sessions
**Solution**: HashMap-based session tracking with proper cleanup

### 5. Missing REST Endpoints
**Problem**: Frontend expected cancel, output, and capability endpoints
**Solution**: Added `/api/provider-sessions/{sessionId}/cancel`, `/api/provider-sessions/{sessionId}/output`, and `/api/providers/capabilities`

### 6. Error Event Handling
**Problem**: WebSocket errors and unexpected closures didn't dispatch UI events
**Solution**: Added `provider-session-error` and `provider-session-complete` event dispatching for all error scenarios

## Remaining Gaps

### 1. Runtime Endpoint Parity (LOW)
**Current boundary is intentional**:
- Streaming runtime routes use `/api/provider-sessions/*` and `/ws/provider-session`.
- Non-stream routes stay on `/api/sessions/*`:
  - `/api/sessions/new`
  - `/api/sessions/{sessionId}/history/{projectId}`

### 2. Stability Follow-up (OUT OF SCOPE HERE)
The remaining work is smoke reliability and unrelated workspace-persistence flakes, which are tracked separately from this contract hardening pass.

## Implementation Notes

### Session-Scoped Events
`apiAdapter.ts` now dispatches both generic and session-scoped `provider-session-*` events once `session_id` is known.

### Provider Capability Contract
Provider runtime capabilities are exposed through:
- Tauri command: `list_provider_capabilities`
- Web route: `/api/providers/capabilities`

`ProviderSessionPane.tsx` consumes these capabilities to gate provider-specific behavior (resume/continue/reasoning/model strategy).

### Web Runtime Session Lifecycle
Web mode now tracks lifecycle explicitly in `AppState`:
```rust
pub struct AppState {
    pub active_sessions: Arc<Mutex<HashMap<String, tokio::sync::mpsc::Sender<String>>>>,
    pub active_cancellations: Arc<Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>>,
    pub session_aliases: Arc<Mutex<HashMap<String, String>>>,
}
```

Cancellation contract:
- `/api/provider-sessions/{sessionId}/cancel` resolves `sessionId` via alias map.
- Cancellation signal is delivered to running process loop.
- Process loop uses `tokio::select!` on process completion vs cancel signal.
- Completion payload is emitted once with status `success | error | cancelled`.

## Performance Considerations

- **Streaming**: Real-time output without buffering delays
- **Memory**: Proper cleanup of completed sessions
- **Concurrency**: Multiple WebSocket connections supported
- **Error Recovery**: Graceful handling of process failures

## Security Notes

- **Binary Execution**: Uses `--dangerously-skip-permissions` flag for web mode
- **CORS**: Allows all origins for development (should be restricted in production)
- **Process Isolation**: Each session runs in separate subprocess
- **Input Validation**: JSON parsing with error handling

## Future Enhancements

1. **Authentication**: Add user authentication for production deployment
2. **Rate Limiting**: Prevent abuse of Claude API calls
3. **Session Persistence**: Save/restore session state across reconnections
4. **Mobile Optimization**: Enhanced UI for mobile browsers
5. **Error Recovery**: Automatic reconnection on WebSocket failures
6. **Process Monitoring**: Add process health checks and automatic restart
7. **Concurrent Session Limits**: Limit number of concurrent Claude processes
8. **File Management**: Add file upload/download capabilities for web mode
9. **Advanced Logging**: Structured logging with log levels and rotation

## Testing

### Manual Testing
1. Start web server: `nix-shell --run 'just web'`
2. Open browser to `http://localhost:8080`
3. Select project directory
4. Send prompt and verify streaming response
5. Check browser console for trace output

### Debug Tools
- **Browser DevTools**: WebSocket messages and console logs
- **Server Logs**: Rust trace output for backend debugging
- **Network Tab**: REST API calls and WebSocket traffic

## Troubleshooting

### Common Issues

1. **No Claude Binary**: Check PATH or install Claude Code
2. **WebSocket Errors**: Verify server is running and accessible
3. **Event Not Received**: Check DOM event listeners in browser console
4. **Process Spawn Failure**: Verify project path and permissions
5. **Session Events Not Working**: Confirm `provider-session-*` scoped events are dispatched after `session_id` is resolved.
6. **Cancel Returns Not Running**: The session may already be completed or not yet aliased from runtime `system:init`.
7. **Concurrent Session Confusion**: Verify each session updates its own scoped channel suffix (`:${sessionId}`).
8. **Errors Not Displayed**: Confirm `provider-session-error` events are forwarded from stderr lines.

### Debug Commands
```bash
# Check Claude binary
which claude

# Test WebSocket endpoint
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: test" -H "Sec-WebSocket-Version: 13" \
  http://localhost:8080/ws/provider-session

# Monitor server logs
tail -f server.log  # if logging to file
```

## Current Status

The web server implementation now provides stable provider-session contract behavior for web mode, with follow-up work focused on smoke reliability and non-contract concerns:

### ✅ Working Features
- WebSocket-based Claude execution with streaming output
- Basic session management and tracking
- REST API endpoints for most functionality
- Comprehensive debugging and tracing
- Error handling for WebSocket failures
- Basic process spawning and output capture

### ❌ Critical Issues (Breaks Core Functionality)
- None in current provider-session contract hardening scope.

### ⚠️ Current State
The web server now has session alias tracking, scoped event parity, stderr forwarding, and real cancellation lifecycle for provider-session runtime paths.

### 🔧 Next Steps
1. Keep non-stream `/api/sessions/*` endpoints unchanged while monitoring provider-session runtime behavior.
2. Run smoke stabilization as a separate track (workspace-persistence and unrelated flakes).

This implementation successfully bridges the gap between Tauri desktop and web deployment, but requires the above fixes to achieve full feature parity while adapting to browser constraints.
