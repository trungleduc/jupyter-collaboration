# Copyright (c) Jupyter Development Team.
# Distributed under the terms of the Modified BSD License.
from __future__ import annotations

import asyncio
from typing import Literal

from jupyter_server.extension.application import ExtensionApp
from jupyter_ydoc import ydocs as YDOCS
from jupyter_ydoc.ybasedoc import YBaseDoc
from pycrdt import Doc
from pycrdt_websocket.ystore import BaseYStore
from traitlets import Bool, Float, Type

from .handlers import DocSessionHandler, YDocWebSocketHandler
from .loaders import FileLoaderMapping
from .rooms import DocumentRoom
from .stores import SQLiteYStore
from .utils import (
    AWARENESS_EVENTS_SCHEMA_PATH,
    EVENTS_SCHEMA_PATH,
    encode_file_path,
    room_id_from_encoded_path,
)
from .websocketserver import JupyterWebsocketServer, RoomNotFound


class YDocExtension(ExtensionApp):
    name = "jupyter_collaboration"
    app_name = "Collaboration"
    description = """
    Enables Real Time Collaboration in JupyterLab
    """

    disable_rtc = Bool(False, config=True, help="Whether to disable real time collaboration.")

    file_poll_interval = Float(
        1,
        config=True,
        help="""The period in seconds to check for file changes on disk.
        Defaults to 1s, if 0 then file changes will only be checked when
        saving changes from the front-end.""",
    )

    document_cleanup_delay = Float(
        60,
        allow_none=True,
        config=True,
        help="""The delay in seconds to keep a document in memory in the back-end after all clients
        disconnect. Defaults to 60s, if None then the document will be kept in memory forever.""",
    )

    document_save_delay = Float(
        1,
        allow_none=True,
        config=True,
        help="""The delay in seconds to wait after a change is made to a document before saving it.
        Defaults to 1s, if None then the document will never be saved.""",
    )

    ystore_class = Type(
        default_value=SQLiteYStore,
        klass=BaseYStore,
        config=True,
        help="""The YStore class to use for storing Y updates. Defaults to an SQLiteYStore,
        which stores Y updates in a '.jupyter_ystore.db' SQLite database in the current
        directory.""",
    )

    server_side_execution = Bool(
        False,
        config=True,
        help="""Whether to execute notebooks in the server using the REST API, not using the kernel
        protocol over WebSocket. The frontend only interacts with the notebook through its shared
        model.""",
    )

    def initialize(self):
        super().initialize()
        self.serverapp.event_logger.register_event_schema(EVENTS_SCHEMA_PATH)
        self.serverapp.event_logger.register_event_schema(AWARENESS_EVENTS_SCHEMA_PATH)

    def initialize_settings(self):
        self.settings.update(
            {
                "collaborative_file_poll_interval": self.file_poll_interval,
                "collaborative_document_cleanup_delay": self.document_cleanup_delay,
                "collaborative_document_save_delay": self.document_save_delay,
                "collaborative_ystore_class": self.ystore_class,
            }
        )

    def initialize_handlers(self):
        self.serverapp.web_app.settings.setdefault(
            "page_config_data",
            {
                "disableRTC": self.disable_rtc,
                "serverSideExecution": self.server_side_execution,
            },
        )

        # Set configurable parameters to YStore class
        for k, v in self.config.get(self.ystore_class.__name__, {}).items():
            setattr(self.ystore_class, k, v)

        self.ywebsocket_server = JupyterWebsocketServer(
            rooms_ready=False,
            auto_clean_rooms=False,
            ystore_class=self.ystore_class,
            log=self.log,
        )

        # self.settings is local to the ExtensionApp but here we need
        # the global app settings in which the file id manager will register
        # itself maybe at a later time.
        self.file_loaders = FileLoaderMapping(
            self.serverapp.web_app.settings, self.log, self.file_poll_interval
        )

        self.handlers.extend(
            [
                (
                    r"/api/collaboration/room/(.*)",
                    YDocWebSocketHandler,
                    {
                        "document_cleanup_delay": self.document_cleanup_delay,
                        "document_save_delay": self.document_save_delay,
                        "file_loaders": self.file_loaders,
                        "ystore_class": self.ystore_class,
                        "ywebsocket_server": self.ywebsocket_server,
                    },
                ),
                (r"/api/collaboration/session/(.*)", DocSessionHandler),
            ]
        )

    async def get_document(
        self: YDocExtension,
        *,
        path: str,
        content_type: Literal["notebook", "file"],
        file_format: Literal["json", "text"],
        copy: bool = True,
    ) -> YBaseDoc | None:
        """Get a view of the shared model for the matching document.

        If `copy=True`, the returned shared model is a fork, meaning that any changes
         made to it will not be propagated to the shared model used by the application.
        """
        file_id_manager = self.serverapp.web_app.settings["file_id_manager"]
        file_id = file_id_manager.index(path)

        encoded_path = encode_file_path(file_format, content_type, file_id)
        room_id = room_id_from_encoded_path(encoded_path)

        try:
            room = await self.ywebsocket_server.get_room(room_id)
        except RoomNotFound:
            return None

        if isinstance(room, DocumentRoom):
            if copy:
                update = room.ydoc.get_update()

                fork_ydoc = Doc()
                fork_ydoc.apply_update(update)

                return YDOCS.get(content_type, YDOCS["file"])(fork_ydoc)
            else:
                return room._document

        return None

    async def stop_extension(self):
        # Cancel tasks and clean up
        await asyncio.wait(
            [
                asyncio.create_task(self.ywebsocket_server.clean()),
                asyncio.create_task(self.file_loaders.clear()),
            ],
            timeout=3,
        )
