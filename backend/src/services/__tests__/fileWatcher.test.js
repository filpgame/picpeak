const mockLimit = jest.fn((operation) => Promise.resolve().then(operation));
const mockPLimit = jest.fn(() => mockLimit);
const mockHandlers = {};
const mockWatcher = {
  on: jest.fn((event, handler) => {
    mockHandlers[event] = handler;
    return mockWatcher;
  }),
};

jest.mock('p-limit', () => mockPLimit);
jest.mock('chokidar', () => ({
  watch: jest.fn(() => mockWatcher),
}));
jest.mock('../../database/db');
jest.mock('../../utils/logger');
jest.mock('../imageProcessor');
jest.mock('../videoProcessor', () => ({
  isVideoMimeType: jest.fn(() => false),
}));
jest.mock('../downloadZipService', () => ({ invalidate: jest.fn() }));
jest.mock('../webhookService', () => ({ fire: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../utils/dbCompat', () => ({
  formatBoolean: jest.fn((value) => value),
}));
jest.mock('mime-types');

let db;
let generateThumbnail;
let mime;

const watchedPath = (slug, filename) =>
  `/test-storage/events/active/${slug}/${filename}`;

const loadFileWatcher = () => {
  let fileWatcher;
  jest.isolateModules(() => {
    ({ db } = require('../../database/db'));
    ({ generateThumbnail } = require('../imageProcessor'));
    mime = require('mime-types');
    fileWatcher = require('../fileWatcher');
  });
  return fileWatcher;
};

describe('fileWatcher concurrency', () => {
  const originalStoragePath = process.env.STORAGE_PATH;
  const originalStorageBackend = process.env.STORAGE_BACKEND;
  const originalConcurrency = process.env.FILE_WATCHER_CONCURRENCY;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(mockHandlers).forEach((key) => delete mockHandlers[key]);
    process.env.STORAGE_PATH = '/test-storage';
    process.env.STORAGE_BACKEND = 'local';
    delete process.env.FILE_WATCHER_CONCURRENCY;
  });

  afterAll(() => {
    if (originalStoragePath === undefined) delete process.env.STORAGE_PATH;
    else process.env.STORAGE_PATH = originalStoragePath;
    if (originalStorageBackend === undefined) delete process.env.STORAGE_BACKEND;
    else process.env.STORAGE_BACKEND = originalStorageBackend;
    if (originalConcurrency === undefined) delete process.env.FILE_WATCHER_CONCURRENCY;
    else process.env.FILE_WATCHER_CONCURRENCY = originalConcurrency;
  });

  it.each([
    [undefined, 2],
    ['3', 3],
    ['0', 1],
    ['-4', 1],
    ['invalid', 2],
  ])('configures p-limit with %s as %i', (configured, expected) => {
    if (configured === undefined) delete process.env.FILE_WATCHER_CONCURRENCY;
    else process.env.FILE_WATCHER_CONCURRENCY = configured;

    const { startFileWatcher } = loadFileWatcher();
    startFileWatcher();

    expect(mockPLimit).toHaveBeenCalledWith(expected);
  });

  it('submits each add event to the shared limiter', async () => {
    const { startFileWatcher } = loadFileWatcher();
    startFileWatcher();

    expect(mockHandlers.add).toEqual(expect.any(Function));
    mockHandlers.add('/outside-watch-root');

    expect(mockLimit).toHaveBeenCalledTimes(1);
    expect(mockLimit).toHaveBeenCalledWith(expect.any(Function));
    await mockLimit.mock.results[0].value;
  });
});

describe('processNewPhoto', () => {
  const originalStoragePath = process.env.STORAGE_PATH;

  beforeAll(() => {
    process.env.STORAGE_PATH = '/test-storage';
  });

  afterAll(() => {
    if (originalStoragePath === undefined) delete process.env.STORAGE_PATH;
    else process.env.STORAGE_PATH = originalStoragePath;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('skips temporary upload files', async () => {
    const { processNewPhoto } = loadFileWatcher();
    mime.lookup.mockReturnValue('image/jpeg');

    await processNewPhoto(watchedPath('event', 'temp_123.jpg'));

    expect(db).not.toHaveBeenCalled();
  });

  it('skips unsupported file extensions', async () => {
    const { processNewPhoto } = loadFileWatcher();
    mime.lookup.mockReturnValue('text/plain');

    await processNewPhoto(watchedPath('event', 'readme.txt'));

    expect(db).not.toHaveBeenCalled();
  });

  it('stops before processing when the event does not exist', async () => {
    const { processNewPhoto } = loadFileWatcher();
    mime.lookup.mockReturnValue('image/jpeg');
    const query = {
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
    };
    db.mockReturnValue(query);

    await processNewPhoto(watchedPath('missing', 'photo.jpg'));

    expect(generateThumbnail).not.toHaveBeenCalled();
  });
});
