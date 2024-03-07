// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.
/**
 * @packageDocumentation
 * @module collaboration-extension
 */

import {
  DocumentRegistry
} from '@jupyterlab/docregistry';

import {
  NotebookPanel, INotebookModel
} from '@jupyterlab/notebook';

import {
  IDisposable, DisposableDelegate
} from '@lumino/disposable';

import { CommandRegistry } from '@lumino/commands';

import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { Dialog, IToolbarWidgetRegistry } from '@jupyterlab/apputils';
import {
  EditorExtensionRegistry,
  IEditorExtensionRegistry
} from '@jupyterlab/codemirror';
import { requestDocMerge, WebSocketAwarenessProvider } from '@jupyter/docprovider';
import {
  SidePanel,
  usersIcon,
  caretDownIcon
} from '@jupyterlab/ui-components';
import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';
import { IStateDB, StateDB } from '@jupyterlab/statedb';
import { ITranslator, nullTranslator, TranslationBundle } from '@jupyterlab/translation';

import { Menu, MenuBar } from '@lumino/widgets';

import { IAwareness, ISharedNotebook, NotebookChange } from '@jupyter/ydoc';

import {
  CollaboratorsPanel,
  IGlobalAwareness,
  IUserMenu,
  remoteUserCursors,
  RendererUserMenu,
  UserInfoPanel,
  UserMenu
} from '@jupyter/collaboration';

import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

/**
 * Jupyter plugin providing the IUserMenu.
 */
export const userMenuPlugin: JupyterFrontEndPlugin<IUserMenu> = {
  id: '@jupyter/collaboration-extension:userMenu',
  description: 'Provide connected user menu.',
  requires: [],
  provides: IUserMenu,
  activate: (app: JupyterFrontEnd): IUserMenu => {
    const { commands } = app;
    const { user } = app.serviceManager;
    return new UserMenu({ commands, user });
  }
};

/**
 * Jupyter plugin adding the IUserMenu to the menu bar if collaborative flag enabled.
 */
export const menuBarPlugin: JupyterFrontEndPlugin<void> = {
  id: '@jupyter/collaboration-extension:user-menu-bar',
  description: 'Add user menu to the interface.',
  autoStart: true,
  requires: [IUserMenu, IToolbarWidgetRegistry],
  activate: async (
    app: JupyterFrontEnd,
    menu: IUserMenu,
    toolbarRegistry: IToolbarWidgetRegistry
  ): Promise<void> => {
    const { user } = app.serviceManager;

    const menuBar = new MenuBar({
      forceItemsPosition: {
        forceX: false,
        forceY: false
      },
      renderer: new RendererUserMenu(user)
    });
    menuBar.id = 'jp-UserMenu';
    user.userChanged.connect(() => menuBar.update());
    menuBar.addMenu(menu as Menu);

    toolbarRegistry.addFactory('TopBar', 'user-menu', () => menuBar);
  }
};

/**
 * Jupyter plugin creating a global awareness for RTC.
 */
export const rtcGlobalAwarenessPlugin: JupyterFrontEndPlugin<IAwareness> = {
  id: '@jupyter/collaboration-extension:rtcGlobalAwareness',
  description: 'Add global awareness to share working document of users.',
  requires: [IStateDB],
  provides: IGlobalAwareness,
  activate: (app: JupyterFrontEnd, state: StateDB): IAwareness => {
    const { user } = app.serviceManager;

    const ydoc = new Y.Doc();
    const awareness = new Awareness(ydoc);

    const server = ServerConnection.makeSettings();
    const url = URLExt.join(server.wsUrl, 'api/collaboration/room');

    new WebSocketAwarenessProvider({
      url: url,
      roomID: 'JupyterLab:globalAwareness',
      awareness: awareness,
      user: user
    });

    state.changed.connect(async () => {
      const data: any = await state.toJSON();
      const current = data['layout-restorer:data']?.main?.current || '';

      if (current.startsWith('editor') || current.startsWith('notebook')) {
        awareness.setLocalStateField('current', current);
      } else {
        awareness.setLocalStateField('current', null);
      }
    });

    return awareness;
  }
};

/**
 * Jupyter plugin adding the RTC information to the application left panel if collaborative flag enabled.
 */
export const rtcPanelPlugin: JupyterFrontEndPlugin<void> = {
  id: '@jupyter/collaboration-extension:rtcPanel',
  description: 'Add side panel to display all currently connected users.',
  autoStart: true,
  requires: [IGlobalAwareness],
  optional: [ITranslator],
  activate: (
    app: JupyterFrontEnd,
    awareness: Awareness,
    translator: ITranslator | null
  ): void => {
    const { user } = app.serviceManager;

    const trans = (translator ?? nullTranslator).load('jupyter_collaboration');

    const userPanel = new SidePanel({
      alignment: 'justify'
    });
    userPanel.id = 'jp-collaboration-panel';
    userPanel.title.icon = usersIcon;
    userPanel.title.caption = trans.__('Collaboration');
    userPanel.addClass('jp-RTCPanel');
    app.shell.add(userPanel, 'left', { rank: 300 });

    const currentUserPanel = new UserInfoPanel(user);
    currentUserPanel.title.label = trans.__('User info');
    currentUserPanel.title.caption = trans.__('User information');
    userPanel.addWidget(currentUserPanel);

    const fileopener = (path: string) => {
      void app.commands.execute('docmanager:open', { path });
    };

    const collaboratorsPanel = new CollaboratorsPanel(
      user,
      awareness,
      fileopener
    );
    collaboratorsPanel.title.label = trans.__('Online Collaborators');
    userPanel.addWidget(collaboratorsPanel);
  }
};

export const userEditorCursors: JupyterFrontEndPlugin<void> = {
  id: '@jupyter/collaboration-extension:userEditorCursors',
  description:
    'Add CodeMirror extension to display remote user cursors and selections.',
  autoStart: true,
  requires: [IEditorExtensionRegistry],
  activate: (
    app: JupyterFrontEnd,
    extensions: IEditorExtensionRegistry
  ): void => {
    extensions.addExtension({
      name: 'remote-user-cursors',
      factory(options) {
        const { awareness, ysource: ytext } = options.model.sharedModel as any;
        return EditorExtensionRegistry.createImmutableExtension(
          remoteUserCursors({ awareness, ytext })
        );
      }
    });
  }
};

/**
 * A plugin to add editing mode to the notebook page
 */
export const editingMode: JupyterFrontEndPlugin<void> = {
  id: '@jupyter/collaboration-extension:editingMode',
  description: 'A plugin to add editing mode to the notebook page.',
  autoStart: true,
  optional: [ITranslator],
  activate: (
    app: JupyterFrontEnd,
    translator: ITranslator | null
  ) => {
    app.docRegistry.addWidgetExtension('Notebook', new EditingModeExtension(translator));
  },
};

export class EditingModeExtension implements DocumentRegistry.IWidgetExtension<NotebookPanel, INotebookModel> {
  private _trans: TranslationBundle;

  constructor(translator: ITranslator | null) {
    this._trans = (translator ?? nullTranslator).load('jupyter_collaboration');
  }

  createNew(
    panel: NotebookPanel,
    context: DocumentRegistry.IContext<INotebookModel>
  ): IDisposable {
    const editingMenubar = new MenuBar();
    const suggestionMenubar = new MenuBar();
    const reviewMenubar = new MenuBar();

    const editingCommands = new CommandRegistry();
    const suggestionCommands = new CommandRegistry();
    const reviewCommands = new CommandRegistry();

    const editingMenu = new Menu({ commands: editingCommands });
    const suggestionMenu = new Menu({ commands: suggestionCommands });
    const reviewMenu = new Menu({ commands: reviewCommands });

    var myForkId = '';  // curently allows only one suggestion per user

    editingMenu.title.label = 'Editing';
    editingMenu.title.icon = caretDownIcon;

    suggestionMenu.title.label = 'Root';
    suggestionMenu.title.icon = caretDownIcon;

    reviewMenu.title.label = 'Review';
    reviewMenu.title.icon = caretDownIcon;

    editingCommands.addCommand('editing', {
      label: 'Editing',
      execute: () => {
        editingMenu.title.label = 'Editing';
        suggestionMenu.title.label = 'Root';
      }
    });
    editingCommands.addCommand('suggesting', {
      label: 'Suggesting',
      execute: () => {
        editingMenu.title.label = 'Suggesting';
        reviewMenu.clearItems();
        if (myForkId === '') {
          myForkId = 'pending';
          const provider = context.model.sharedModel.provider;
          provider.fork().then(newForkId => {
            myForkId = newForkId;
            provider.connectFork(newForkId);
            suggestionMenu.title.label = newForkId;
          });
        }
        else {
          suggestionMenu.title.label = myForkId;
          context.model.sharedModel.provider.connectFork(myForkId);
        }
      }
    });

    suggestionCommands.addCommand('root', {
      label: 'Root',
      execute: () => {
        // we cannot review the root document
        reviewMenu.clearItems();
        suggestionMenu.title.label = 'Root';
        editingMenu.title.label = 'Editing';
        context.model.sharedModel.provider.connectFork(context.model.sharedModel.rootRoomId);
      }
    });

    reviewCommands.addCommand('merge', {
      label: 'Merge',
      execute: () => {
        requestDocMerge(context.model.sharedModel.currentRoomId, context.model.sharedModel.rootRoomId);
      }
    });
    reviewCommands.addCommand('discard', {
      label: 'Discard',
      execute: () => {
      }
    });

    editingMenu.addItem({type: 'command', command: 'editing'});
    editingMenu.addItem({type: 'command', command: 'suggesting'});

    suggestionMenu.addItem({type: 'command', command: 'root'});

    const _onStateChanged = (sender: ISharedNotebook, changes: NotebookChange) => {
      if (changes.stateChange) {
        changes.stateChange.forEach(value => {
          const forkPrefix = 'fork_';
          if (value.name.startsWith(forkPrefix)) {
            const newForkId = value.name.slice(forkPrefix.length);
            suggestionCommands.addCommand(newForkId, {
              label: newForkId,
              execute: () => {
                if (myForkId === newForkId) {
                  editingMenu.title.label = 'Suggesting';
                  // our suggestion, cannot be reviewed
                  reviewMenu.clearItems();
                }
                else {
                  editingMenu.title.label = 'Editing';
                  // not our suggestion, can be reviewed
                  reviewMenu.clearItems();
                  reviewMenu.addItem({type: 'command', command: 'merge'});
                  reviewMenu.addItem({type: 'command', command: 'discard'});
                }
                suggestionMenu.title.label = newForkId;
                context.model.sharedModel.provider.connectFork(newForkId);
                const dialog = new Dialog({
                  title: this._trans.__('Suggestion'),
                  body: this._trans.__('Your are now viewing the suggestion.'),
                  buttons: [Dialog.okButton({ label: 'OK' })],
                });
                dialog.launch().then(resp => { dialog.close(); });
              }
            });
            suggestionMenu.addItem({type: 'command', command: newForkId});
            if ((myForkId !== 'pending') && (myForkId !== newForkId)) {
              const dialog = new Dialog({
                title: this._trans.__('New suggestion'),
                body: this._trans.__('Open notebook for suggestion?'),
                buttons: [
                  Dialog.okButton({ label: 'Open' }),
                  Dialog.cancelButton({ label: 'Discard' }),
                ],
              });
              dialog.launch().then(resp => {
                dialog.close();
                if (resp.button.label === 'Open') {
                  context.model.sharedModel.provider.connectFork(newForkId);
                  suggestionMenu.title.label = newForkId;
                  editingMenu.title.label = 'Editing';
                  reviewMenu.clearItems();
                  reviewMenu.addItem({type: 'command', command: 'merge'});
                  reviewMenu.addItem({type: 'command', command: 'discard'});
                }
              });
            }
          }
        });
      }
    };

    context.model.sharedModel.changed.connect(_onStateChanged, this);

    editingMenubar.addMenu(editingMenu);
    suggestionMenubar.addMenu(suggestionMenu);
    reviewMenubar.addMenu(reviewMenu);

    panel.toolbar.insertItem(997, 'editingMode', editingMenubar);
    panel.toolbar.insertItem(998, 'suggestions', suggestionMenubar);
    panel.toolbar.insertItem(999, 'review', reviewMenubar);
    return new DisposableDelegate(() => {
      editingMenubar.dispose();
      suggestionMenubar.dispose();
      reviewMenubar.dispose();
    });
  }
}
