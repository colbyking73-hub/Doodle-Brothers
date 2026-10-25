# Doodle Brothers

A Smash-style stickman platform fighter. Fight a friend on the same keyboard/controllers, against the CPU, or **online**.

## Download

1. Go to the **Releases** page (right side of this repository) and download `Doodle-Brothers-Setup-x.y.z.exe` from the newest release.
2. Run it. Windows may show "Windows protected your PC" because the game isn't code-signed. Click **More info**, then **Run anyway**.
3. The game installs and opens. It has a desktop shortcut.

The game **updates itself**. When a new version is out, it downloads in the background and asks to restart.

## Playing online

1. On the character select screen, click **ONLINE** (top-left).
2. One player clicks **HOST A GAME** and sends the 5-letter code to the other.
3. The other player types the code and clicks **JOIN**.
4. Both pick a fighter and click **READY**. The host picks the stage and stocks, then clicks **START MATCH**.

- Both players need the **same version** of the game. Update first if the lobby says your versions differ.
- Press **ESC twice** to leave a match.
- It connects the two computers directly. A few networks (some school/work Wi-Fi) block direct connections. If it won't connect, try a different network or a phone hotspot.

## Controls

Default keyboard: move **A/D**, jump **W/Space**, down **S**, physical attack **J**, ranged attack **K**, shield **L/Shift**. Xbox controllers work too. Change the bindings under **CONTROLS** on the character select screen. **F11** toggles fullscreen.

## For the developer: publishing an update

```powershell
.\release.ps1          # small update: 0.1.0 -> 0.1.1
.\release.ps1 minor    # bigger update: 0.1.0 -> 0.2.0
```

This bumps the version and pushes a tag. GitHub Actions builds the installer and publishes the release (about 5 minutes), and installed games pick it up automatically.
