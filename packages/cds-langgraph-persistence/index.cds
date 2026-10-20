//////////////////////////////////////////
///// CHECKPOINTS (SHORT-TERM MEMORY) ////
//////////////////////////////////////////

// NOTE: `parent_id` & `checkpoint_*` fields are used to keep backwards compatibility with the previous
//       `entity` based implementation where there were associations/compositions relationships.

aspect Checkpoint {
    key graphName  : String(256) not null;
    key id         : String(256) not null;
    key namespace  : String(256) not null default '';
    key threadId   : String(256) not null;
        parent_id  : String(256);
        type       : String(64);
        checkpoint : LargeString not null;
        metadata   : LargeString;
        createdAt  : Timestamp default $now;
        updatedAt  : Timestamp default $now @cds.on.update: $now;
        expiresAt  : Timestamp;
}

aspect CheckpointWrite {
    key checkpoint_graphName : String(256) not null;
    key checkpoint_id        : String(256) not null;
    key checkpoint_namespace : String(256) not null default '';
    key checkpoint_threadId  : String(256) not null;
    key taskId               : String(256) not null;
    key idx                  : Integer not null;
        taskPath             : LargeString;
        channel              : String(256) not null;
        type                 : String(64);
        value                : LargeString;
}
