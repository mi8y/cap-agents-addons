using {
  cuid,
  managed
} from '@sap/cds/common';

service IngestService {
  type IngestionResult {
    fileId     : UUID;
    chunkCount : Integer;
  }

  entity TextFiles : cuid, managed {
    @Core.MediaType                  : mediaType
    @Core.ContentDisposition.Filename: fileName
    @Core.ContentDisposition.Type    : 'inline'
    content   : LargeBinary;
    fileName  : String(255);
    mediaType : String(100) default 'text/plain';
  } actions {
    action ingest() returns IngestionResult;
  };
}
