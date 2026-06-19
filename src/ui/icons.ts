// Google Material Symbols (outlined, weight 400), downloaded locally to
// src/assets/icons so the app stays offline/local-first. The raw SVG markup is
// inlined (Vite `?raw`) so it inherits `currentColor` via CSS — see the
// `.icon` rules in styles.css. Replaces the previous emoji glyphs.

import chevronRight from "../assets/icons/chevron_right.svg?raw";
import close from "../assets/icons/close.svg?raw";
import createNewFolder from "../assets/icons/create_new_folder.svg?raw";
import deleteIcon from "../assets/icons/delete.svg?raw";
import description from "../assets/icons/description.svg?raw";
import download from "../assets/icons/download.svg?raw";
import edit from "../assets/icons/edit.svg?raw";
import folder from "../assets/icons/folder.svg?raw";
import editSquare from "../assets/icons/edit_square.svg?raw";
import expandMore from "../assets/icons/expand_more.svg?raw";
import folderOpen from "../assets/icons/folder_open.svg?raw";
import hub from "../assets/icons/hub.svg?raw";
import merge from "../assets/icons/merge.svg?raw";
import noteAdd from "../assets/icons/note_add.svg?raw";
import settings from "../assets/icons/settings.svg?raw";
import tag from "../assets/icons/tag.svg?raw";
import visibility from "../assets/icons/visibility.svg?raw";

const SVGS = {
  chevronRight,
  close,
  createNewFolder,
  delete: deleteIcon,
  description,
  download,
  edit,
  rename: editSquare,
  expandMore,
  folder,
  folderOpen,
  hub,
  merge,
  noteAdd,
  settings,
  tag,
  visibility,
} as const;

export type IconName = keyof typeof SVGS;

/** Raw SVG markup for an icon, wrapped so CSS can size/color it via `.icon`. */
export function iconSvg(name: IconName): string {
  return `<span class="icon">${SVGS[name]}</span>`;
}
