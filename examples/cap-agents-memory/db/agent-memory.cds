namespace plugin.langgraph.memory;

using { StoreItem, StoreItemField } from '@mi8y/cap-agents-memory';

entity StoreItems : StoreItem {
    fields : Composition of many StoreItemFields
                 on fields.item = $self;
}

entity StoreItemFields : StoreItemField {
    item      : Association to StoreItems
                    on  item.graphName = $self.graphName
                    and item.namespace = $self.namespace
                    and item.id        = $self.id;
    embedding : Vector(1536); // Configure the dimension for the embedding model in use.
}
