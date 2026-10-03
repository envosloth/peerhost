import type { MenuItemConstructorOptions } from 'electron';

/** Packaged builds get no DevTools or force-reload: the renderer is a privileged local UI, not a web page. */
export function applicationMenuTemplate(packaged: boolean, actions: { show: () => void; quit: () => void }): MenuItemConstructorOptions[] {
  const view: MenuItemConstructorOptions[] = packaged
    ? [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }]
    : [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }];
  return [
    { label: 'PeerHost', submenu: [{ label: 'Open', click: actions.show }, { label: 'Quit safely', click: actions.quit }] },
    { label: 'View', submenu: view },
  ];
}
