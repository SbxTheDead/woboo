// Custom face skins.
//
// The widget and dashboard share a face rendered from faceart.mjs. Skins let
// the owner change the color palette without touching the geometry. A skin is
// just a set of CSS variable overrides.

import { loadSettings, saveSettings } from './config.mjs';

export const BUILT_IN = {
  default: {
    name: 'Default',
    vars: { '--fc': '#FFB55C', '--bg': '#08080B', '--panel': '#0C0C11', '--ok': '#7FD1A0', '--bad': '#FF5A3D', '--warn': '#FF9264' },
  },
  ocean: {
    name: 'Ocean',
    vars: { '--fc': '#5CB8FF', '--bg': '#060A0F', '--panel': '#0A1018', '--ok': '#5CD1A0', '--bad': '#FF5A6D', '--warn': '#FFB55C' },
  },
  forest: {
    name: 'Forest',
    vars: { '--fc': '#7FD1A0', '--bg': '#060B08', '--panel': '#0A120E', '--ok': '#5CD1A0', '--bad': '#FF6B5A', '--warn': '#FFD15C' },
  },
  sunset: {
    name: 'Sunset',
    vars: { '--fc': '#FF6B8A', '--bg': '#0B0608', '--panel': '#120A0E', '--ok': '#7FD1A0', '--bad': '#FF5A3D', '--warn': '#FFB55C' },
  },
  mono: {
    name: 'Mono',
    vars: { '--fc': '#FFFFFF', '--bg': '#000000', '--panel': '#0A0A0A', '--ok': '#AAAAAA', '--bad': '#FFFFFF', '--warn': '#CCCCCC' },
  },
  neon: {
    name: 'Neon',
    vars: { '--fc': '#00FF88', '--bg': '#050510', '--panel': '#0A0A1A', '--ok': '#00FF88', '--bad': '#FF0055', '--warn': '#FFAA00' },
  },
};

export function current() {
  const name = loadSettings().skin || 'default';
  return BUILT_IN[name] || BUILT_IN.default;
}

export function set(name) {
  if (!BUILT_IN[name]) return false;
  saveSettings({ skin: name });
  return true;
}

export function list() {
  return Object.entries(BUILT_IN).map(([id, skin]) => ({ id, name: skin.name }));
}

export function vars() {
  return current().vars;
}
