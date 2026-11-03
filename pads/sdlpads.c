// DOODLE BROTHERS - STEAM CONTROLLER HELPER (Windows)
//
// The game runs in Chromium, which can't see Valve's controllers (the 2026 Steam Controller, the original one, a Steam
// Deck running Windows): with Steam running they turn into a mouse + keyboard instead. SDL 3 has its own drivers for
// them, so the app starts this little program next to the game. It reads them with SDL and prints their state, one
// line of JSON whenever anything changes, already in the browser's "standard" gamepad layout:
//
//   [{"i":0,"id":"Steam Controller","b":[...buttons 0-21, 0..1],"a":[lx,ly,rx,ry],"t":0}]
//
//   buttons: 0 A  1 B  2 X  3 Y  4 LB  5 RB  6 LT  7 RT  8 VIEW  9 MENU  10 L-STICK  11 R-STICK  12-15 D-PAD (U D L R)
//            16 STEAM  17 R4  18 L4  19 R5  20 L5  21 "..." (quick access)
//   t = a finger is on a trackpad (the game ignores Steam's mouse/keyboard while you use the controller)
//
// Only Valve's controllers are reported - everything else the game already reads itself. If Steam launched the game
// with Steam Input on (a "Steam Virtual Gamepad" exists), nothing is reported: Steam already hands the game an Xbox-style pad.
// The helper quits as soon as the game does (its process id is passed as the first argument).

#define SDL_MAIN_HANDLED
#include <SDL3/SDL.h>
#include <SDL3/SDL_main.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <windows.h>
#endif

#define VALVE_VID 0x28DE
#define VALVE_VIRTUAL_PID 0x11FF          // Steam Input's virtual (Xbox-style) gamepad
#define MAX_PADS 8
#define NUM_BTNS 22

typedef struct { SDL_JoystickID id; SDL_Gamepad *pad; } Slot;
static Slot slots[MAX_PADS];
static int virtualPads = 0;

// the standard layout's buttons (-1 / -2 = the triggers, read from their axes)
static const int BTN_MAP[NUM_BTNS] = {
  SDL_GAMEPAD_BUTTON_SOUTH, SDL_GAMEPAD_BUTTON_EAST, SDL_GAMEPAD_BUTTON_WEST, SDL_GAMEPAD_BUTTON_NORTH,
  SDL_GAMEPAD_BUTTON_LEFT_SHOULDER, SDL_GAMEPAD_BUTTON_RIGHT_SHOULDER, -1, -2,
  SDL_GAMEPAD_BUTTON_BACK, SDL_GAMEPAD_BUTTON_START, SDL_GAMEPAD_BUTTON_LEFT_STICK, SDL_GAMEPAD_BUTTON_RIGHT_STICK,
  SDL_GAMEPAD_BUTTON_DPAD_UP, SDL_GAMEPAD_BUTTON_DPAD_DOWN, SDL_GAMEPAD_BUTTON_DPAD_LEFT, SDL_GAMEPAD_BUTTON_DPAD_RIGHT,
  SDL_GAMEPAD_BUTTON_GUIDE, SDL_GAMEPAD_BUTTON_RIGHT_PADDLE1, SDL_GAMEPAD_BUTTON_LEFT_PADDLE1,
  SDL_GAMEPAD_BUTTON_RIGHT_PADDLE2, SDL_GAMEPAD_BUTTON_LEFT_PADDLE2, SDL_GAMEPAD_BUTTON_MISC1,
};

static bool isVirtual(SDL_JoystickID id) {
  return SDL_GetGamepadVendorForID(id) == VALVE_VID && SDL_GetGamepadProductForID(id) == VALVE_VIRTUAL_PID;
}
static bool wanted(SDL_JoystickID id) {
  return SDL_GetGamepadVendorForID(id) == VALVE_VID && SDL_GetGamepadProductForID(id) != VALVE_VIRTUAL_PID;
}

static void added(SDL_JoystickID id) {
  if (isVirtual(id)) { virtualPads++; return; }
  if (!wanted(id)) return;
  for (int s = 0; s < MAX_PADS; s++) if (slots[s].pad && slots[s].id == id) return;
  for (int s = 0; s < MAX_PADS; s++) {
    if (slots[s].pad) continue;
    SDL_Gamepad *g = SDL_OpenGamepad(id);
    if (!g) return;
    // (the same controller seen twice - e.g. by cable AND wirelessly - is only reported once)
    const char *ser = SDL_GetGamepadSerial(g);
    if (ser && *ser) for (int o = 0; o < MAX_PADS; o++) {
      const char *os = slots[o].pad ? SDL_GetGamepadSerial(slots[o].pad) : NULL;
      if (os && SDL_strcmp(os, ser) == 0) { SDL_CloseGamepad(g); return; }
    }
    slots[s].id = id; slots[s].pad = g;
    return;
  }
}
static void removed(SDL_JoystickID id) {
  bool mine = false;
  for (int s = 0; s < MAX_PADS; s++) if (slots[s].pad && slots[s].id == id) {
    SDL_CloseGamepad(slots[s].pad); slots[s].pad = NULL; slots[s].id = 0; mine = true;
  }
  if (!mine && virtualPads > 0 && SDL_GetGamepadVendorForID(id) == VALVE_VID) {
    // (the virtual pad went away - recount the ones still there, since a removed device's ids can't be asked about)
    int n = 0, count = 0;
    SDL_JoystickID *ids = SDL_GetGamepads(&count);
    if (ids) { for (int k = 0; k < count; k++) if (isVirtual(ids[k])) n++; SDL_free(ids); }
    virtualPads = n;
  }
}

// (a small dead zone, and steps of 0.02, so a stick resting on the table doesn't count as "in use" with every tiny jitter -
//  the game ignores Steam's keyboard copy whenever the controller is being used)
static float axisVal(SDL_Gamepad *g, SDL_GamepadAxis a) {
  float v = SDL_GetGamepadAxis(g, a) / 32767.0f;
  v = v < -1 ? -1 : v > 1 ? 1 : v;
  if (v > -0.08f && v < 0.08f) return 0;
  return SDL_roundf(v * 50) / 50;
}
static void appendf(char *buf, size_t cap, size_t *len, const char *fmt, ...) {
  if (*len >= cap) return;
  va_list ap; va_start(ap, fmt);
  int n = vsnprintf(buf + *len, cap - *len, fmt, ap);
  va_end(ap);
  if (n > 0) *len += (size_t)n;
}
static void build(char *out, size_t cap) {
  size_t len = 0;
  appendf(out, cap, &len, "[");
  bool first = true;
  if (virtualPads == 0) for (int s = 0; s < MAX_PADS; s++) {
    SDL_Gamepad *g = slots[s].pad;
    if (!g || !SDL_GamepadConnected(g)) continue;
    char name[64]; const char *nm = SDL_GetGamepadName(g); size_t k = 0;
    for (const char *p = nm ? nm : "Steam Controller"; *p && k < sizeof(name) - 1; p++) if (*p != '"' && *p != '\\' && (unsigned char)*p >= 32) name[k++] = *p;
    name[k] = 0;
    appendf(out, cap, &len, "%s{\"i\":%d,\"id\":\"%s\",\"b\":[", first ? "" : ",", s, name);
    first = false;
    for (int b = 0; b < NUM_BTNS; b++) {
      float v = 0;
      if (BTN_MAP[b] == -1) v = axisVal(g, SDL_GAMEPAD_AXIS_LEFT_TRIGGER);
      else if (BTN_MAP[b] == -2) v = axisVal(g, SDL_GAMEPAD_AXIS_RIGHT_TRIGGER);
      else v = SDL_GetGamepadButton(g, (SDL_GamepadButton)BTN_MAP[b]) ? 1.0f : 0.0f;
      if (v < 0) v = 0;
      appendf(out, cap, &len, b ? ",%.2f" : "%.2f", v);
    }
    appendf(out, cap, &len, "],\"a\":[%.3f,%.3f,%.3f,%.3f],\"t\":",
            axisVal(g, SDL_GAMEPAD_AXIS_LEFTX), axisVal(g, SDL_GAMEPAD_AXIS_LEFTY),
            axisVal(g, SDL_GAMEPAD_AXIS_RIGHTX), axisVal(g, SDL_GAMEPAD_AXIS_RIGHTY));
    int touching = 0;
    for (int t = 0; t < SDL_GetNumGamepadTouchpads(g) && !touching; t++)
      for (int f = 0; f < SDL_GetNumGamepadTouchpadFingers(g, t); f++) {
        bool down = false; float fx, fy, fp;
        if (SDL_GetGamepadTouchpadFinger(g, t, f, &down, &fx, &fy, &fp) && down) { touching = 1; break; }
      }
    appendf(out, cap, &len, "%d}", touching);
  }
  appendf(out, cap, &len, "]");
}

int main(int argc, char **argv) {
#ifdef _WIN32
  HANDLE parent = NULL;
  if (argc > 1) parent = OpenProcess(SYNCHRONIZE, FALSE, (DWORD)strtoul(argv[1], NULL, 10));
#endif
  SDL_SetMainReady();
  SDL_SetHint(SDL_HINT_JOYSTICK_HIDAPI_STEAM, "1");                  // Valve's own controllers, read directly
  SDL_SetHint(SDL_HINT_JOYSTICK_ALLOW_BACKGROUND_EVENTS, "1");       // (no window of its own - always listen)
  if (!SDL_Init(SDL_INIT_GAMEPAD)) { fprintf(stderr, "SDL_Init failed: %s\n", SDL_GetError()); return 1; }
  printf("[]\n"); fflush(stdout);
  static char last[16384] = "[]", cur[16384];
  Uint64 lastBeat = SDL_GetTicks();
  for (;;) {
#ifdef _WIN32
    if (parent && WaitForSingleObject(parent, 0) == WAIT_OBJECT_0) break;   // the game closed
#endif
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
      if (e.type == SDL_EVENT_GAMEPAD_ADDED) added(e.gdevice.which);
      else if (e.type == SDL_EVENT_GAMEPAD_REMOVED) removed(e.gdevice.which);
    }
    build(cur, sizeof cur);
    Uint64 now = SDL_GetTicks();
    if (strcmp(cur, last) != 0 || now - lastBeat > 1000) {           // on every change (+ once a second, so the app knows it's alive)
      if (fputs(cur, stdout) < 0 || fputc('\n', stdout) == EOF || fflush(stdout) != 0) break;   // (the pipe closed: the game's gone)
      memcpy(last, cur, strlen(cur) + 1); lastBeat = now;
    }
    SDL_Delay(4);
  }
  for (int s = 0; s < MAX_PADS; s++) if (slots[s].pad) SDL_CloseGamepad(slots[s].pad);
  SDL_Quit();
  return 0;
}
