# Flint

A survival voxel engine that runs in one HTML file, with an optional small multiplayer server. It has an infinite procedurally generated world, WebGL2 rendering, and works on desktop and mobile browsers.

Flint is meant as the core of a larger survival game. The design rules are:

- Balance CPU, memory and GPU.
- Keep polygon counts and code size small.
- Use one level-of-detail system.

## Features

- **Infinite world:** seeded terrain with lakes, beaches, plains, forests, hills and stone mountains.
- **Survival basics:** health, hunger, hotbar, inventory, breaking and placing blocks, sprinting, crouching and swimming.
- **Shaped blocks:** slabs, stairs, fences, doors and trapdoors. Turn the block in your hand with **F** (or the on-screen button), and split stacks from the inventory.
- **Multiplayer:** up to 16 players, custom skins (64×64 PNG), combat, a shared day cycle and a shared saved world.
- **Minimap:** a corner map and a full-screen map with zoom, pan, tree tops, player-built blocks and every player's face. See [Minimap](#minimap).
- **Single player works offline:** edits are saved in the browser (IndexedDB), and menu settings in localStorage.

## Quick start

### Single player

Open `Flint-multiplayer.html` in a browser that supports WebGL2. No server or build step is needed.

### Multiplayer

Requires Node 18 or newer.

```bash
npm i ws
node flint-server.js [port]     # default port 8080
```

Then open the game with the server address and your name in the URL hash:

```
Flint-multiplayer.html#mp=ws://localhost:8080&name=Alice
```

Share the same address with friends, using your machine's IP or hostname instead of `localhost`.

Notes:

- The server owns the world seed and every saved block edit. It writes them to `flint-world.json` in its working directory every few seconds and on exit. Delete that file to start a new world.
- If you host the HTML page over HTTPS, the browser requires a secure socket (`wss://`). Put the server behind a TLS reverse proxy.
- The server trusts clients but validates input and rate limits it. It runs no world generation or physics.

## Controls

### PC

| Action | Key |
| --- | --- |
| Move | W A S D |
| Jump | Space |
| Sprint | Shift |
| Crouch | C |
| Break / attack | Left click |
| Place | Right click |
| Select hotbar slot | Mouse wheel |
| Inventory | E |
| Turn shaped block | F |
| Map | M |
| Menu | Esc |

Click the game to capture the mouse.

### Mobile

- Drag on the left side to move and on the right side to look.
- Use the on-screen buttons for jump, sprint and crouch, and the bag and menu buttons at the top right.
- Tap the corner minimap to open the full map.

## Minimap

**Corner map** (top left)
- Shows the terrain around you, north up, with a cone for where you are looking, your coordinates and the spawn point.
- On touch, tap it to open the full map, or pinch it with two fingers to change its range.
- On PC, use its corner button or press **M**. The mouse wheel changes its range while the mouse is free.

**Full map**
- **Pan:** drag, or use the arrow keys or WASD.
- **Zoom:** wheel, pinch, double-click, the + / − buttons, or + and − on the keyboard.
- **Follow:** tap a player chip or icon at the bottom to follow that player. The ◎ button (or **C**) follows you again.
- **Close:** M, Esc or ✕.
- **Players:** other players appear as their own face, with a pointer for where they look. Players off screen sit on the edge of the map, pointing toward them.

**What the map draws:** the top block of every column. That means ground, lakes by depth, tree tops, and every block a player has placed or broken, updated live. Slabs, stairs, fences, doors and trapdoors show as planks. The world is infinite, so the map shows the terrain around you at any zoom, from about 100 blocks across to about 19,000.

**How it works**
- Terrain is painted in 64×64 tiles that are cached and made once, a few milliseconds at a time.
- The server sends every player's position five times a second whether or not they are in view, plus names, faces and departures. Players far apart still appear on each other's maps.

## Files

| File | Purpose |
| --- | --- |
| `Flint-multiplayer.html` | The whole game: engine, UI, minimap and the multiplayer client |
| `flint-server.js` | The multiplayer server (Node and `ws`) |

The client is one file split into numbered sections (world generation, meshing, lighting, survival, rigs and skins, multiplayer, PC controls, shaped blocks, minimap). The server's header comment documents the binary wire format.

## Requirements

- A modern browser with WebGL2.
- A recent browser for the UI. It uses the CSS `:has()` selector, which needs Chrome 105+, Safari 15.4+ or Firefox 121+.
- Node 18+ and the `ws` package, for multiplayer only.

## License

Add your license here.
