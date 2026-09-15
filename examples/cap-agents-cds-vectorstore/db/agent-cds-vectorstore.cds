namespace plugin.langchain.vectorstore;

using {managed} from '@sap/cds/common';
using {
    VectorDocument,
    VectorDocumentMetadata
} from '@mi8y/cap-agents-cds-vectorstore';

entity Documents : managed, VectorDocument {
    embedding : Vector(1536); // IMPORTANT: The field name must be "embedding". // NOTE: The vector dimension must match the embedding model used
    metadata  : Composition of many DocumentMetadata
                    on metadata.document = $self;
}

entity DocumentMetadata : VectorDocumentMetadata {
    document : Association to Documents
                   on  document.storeName  = $self.storeName
                   and document.documentId = $self.documentId;
}
