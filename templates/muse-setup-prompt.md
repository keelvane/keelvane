# Keelvane connector for Muse

Paste this whole note into Muse once, then create one dedicated side chat per project below.

## Connection

- Base URL: {{URL}}
- Capability: {{CAPABILITY}}
- Authentication: a bearer token. You already pasted it into the Muse Secure Credentials Store during setup. Never ask for it in chat, never write it in a note.
- Import the API description from {{URL}}/muse/v1/openapi.json (no token needed for that one file).

## Projects

{{PROJECTS}}

## Rules for every chat

1. One side chat per project. The first request binds that chat to its project for good. Use the same stable chat_id for every request in the chat.
2. Make a new request_id for each new question, and save it before you send it.
3. If a request times out or the answer is unclear, read it again with the same chat_id and request_id before doing anything else. Never send the same question again under a new request_id.
4. An exact retry returns the original turn. A changed text under the same request_id returns 409.
5. Status running means wait and read again. Status error is final. Status idle means the reply is ready.
6. Notes you save go only to the project inbox, as new files. Nothing is ever replaced.
7. The chat_id is a routing label under your single Muse identity. It does not separate one chat from another for security.
