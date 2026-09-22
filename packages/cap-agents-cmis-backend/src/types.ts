export enum CmisPropertyName {
  NAME = "cmis:name",
  OBJECT_ID = "cmis:objectId",
  OBJECT_TYPE_ID = "cmis:objectTypeId",
  BASE_TYPE_ID = "cmis:baseTypeId",
  CONTENT_STREAM_LENGTH = "cmis:contentStreamLength",
  CONTENT_STREAM_MIME_TYPE = "cmis:contentStreamMimeType",
  CREATION_DATE = "cmis:creationDate",
  LAST_MODIFICATION_DATE = "cmis:lastModificationDate",
  CHANGE_TOKEN = "cmis:changeToken",
  PATH = "cmis:path",
}

export type CmisObject = {
  succinctProperties: Record<string, unknown>;
};

export type CmisObjectInFolder = {
  object: CmisObject;
  pathSegment: string;
};

export type CmisObjectInFolderList = {
  objects: CmisObjectInFolder[];
  hasMoreItems?: boolean;
  numItems?: number;
};

/** Recursive entry returned by the Browser Binding descendants selector. */
export type CmisObjectInFolderContainer = {
  object: CmisObjectInFolder;
  children?: CmisObjectInFolderContainer[];
};

export type CmisQueryResultList = {
  results: CmisObject[];
  hasMoreItems?: boolean;
  numItems?: number;
};

export type CmisPagingOptions = {
  maxItems?: number;
  skipCount?: number;
};
