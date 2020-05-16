import debounce from 'debounce';
import fs from 'fs';
import { exec } from 'child_process';
import googleapis from 'googleapis';
import path from 'path';
import readline from 'readline';

const { google } = googleapis;

// If modifying these scopes, delete token.json.
// const SCOPES = ['https://www.googleapis.com/auth/drive.metadata.readonly'];
const SCOPES = ['https://www.googleapis.com/auth/drive'];
// The file token.json stores the user's access and refresh tokens, and is
// created automatically when the authorization flow completes for the first
// time.
const TOKEN_PATH = 'token.json';

const resolveHome = filePath => {
  if (filePath[0] === '~') {
    return path.join(process.env.HOME, filePath.slice(1));
  }
  return filePath;
};

/**
 * Get and store new token after prompting for user authorization, and then
 * execute the given callback with the authorized OAuth2 client.
 * @param {google.auth.OAuth2} oAuth2Client The OAuth2 client to get token for.
 * @param {getEventsCallback} callback The callback for the authorized client.
 */
const getAccessToken = async oAuth2Client => new Promise((resolve, reject) => {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  // eslint-disable-next-line no-console
  console.log('Authorize this app by visiting this url:', authUrl);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.question('Enter the code from that page here: ', code => {
    rl.close();
    oAuth2Client.getToken(code, (err, token) => {
      if (err) {
        reject(new Error(`Error retrieving access token ${err}`));
        return;
      }
      oAuth2Client.setCredentials(token);
      // Store the token to disk for later program executions
      fs.writeFile(TOKEN_PATH, JSON.stringify(token), writeErr => {
        if (writeErr) {
          reject(new Error(writeErr));
          return;
        }
        resolve(oAuth2Client);
      });
    });
  });
});

/**
 * Create an OAuth2 client with the given credentials, and then execute the
 * given callback function.
 * @param {Object} credentials The authorization client credentials.
 * @param {function} callback The callback to call with the authorized client.
 */
const authorize = async credentials => new Promise(resolve => {
  // eslint-disable-next-line camelcase
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  // Check if we have previously stored a token.
  fs.readFile(TOKEN_PATH, async (err, token) => {
    if (err) {
      await getAccessToken(oAuth2Client);
    } else {
      oAuth2Client.setCredentials(JSON.parse(token));
    }
    resolve(oAuth2Client);
  });
});

const getOAuth2Client = async () => new Promise((resolve, reject) => {
  // Load client secrets from a local file.
  fs.readFile('credentials.json', async (err, content) => {
    if (err) {
      reject(new Error(`Error loading client secret file: ${err}`));
      return;
    }
    // Authorize a client with credentials, then call the Google Drive API.
    const oAuth2Client = await authorize(JSON.parse(content));
    resolve(oAuth2Client);
  });
});

const deleteFile = async (oAuth2Client, fileId) => new Promise((resolve, reject) => {
  const drive = google.drive({ version: 'v3', auth: oAuth2Client });
  drive.files.delete({ fileId }, delErr => {
    if (delErr) {
      reject(new Error(`The API returned an error: ${delErr}`));
      return;
    }
    resolve();
  });
});

const getFileIds = async (oAuth2Client, name) => new Promise((resolve, reject) => {
  const drive = google.drive({ version: 'v3', auth: oAuth2Client });
  drive.files.list({
    pageSize: 30,
    fields: 'nextPageToken, files(id, name)',
    q: `name = "${name}"`,
  }, (err, res) => {
    if (err) {
      reject(new Error(`The API returned an error: ${err}`));
      return;
    }
    const { files } = res.data;
    const fileIds = files.filter(file => file.name === name).map(file => file.id);
    resolve(fileIds);
  });
});

const uploadDocument = async (oAuth2Client, name, docPath) => new Promise((resolve, reject) => {
  const drive = google.drive({ version: 'v3', auth: oAuth2Client });
  const fileMetadata = {
    name,
    mimeType: 'application/vnd.google-apps.document',
  };
  const media = {
    mimeType: 'application/vnd.oasis.opendocument.text',
    body: fs.createReadStream(docPath),
  };
  drive.files.create({
    resource: fileMetadata,
    media,
    fields: 'id',
  }, (err, file) => {
    if (err) {
      reject(err);
    } else {
      resolve(file.id);
    }
  });
});

const updateDocument = async (oAuth2Client, name, docPath) => {
  const fileIds = await getFileIds(oAuth2Client, name);
  if (fileIds.length > 1) {
    throw new Error(`more than one version of document exists: ${name}`);
  } else if (fileIds.length === 0) {
    return uploadDocument(oAuth2Client, name, docPath);
  } else {
    const fileId = fileIds[0];
    return new Promise((resolve, reject) => {
      const drive = google.drive({ version: 'v3', auth: oAuth2Client });
      const fileMetadata = {
        name,
        mimeType: 'application/vnd.google-apps.document',
      };
      const media = {
        mimeType: 'application/vnd.oasis.opendocument.text',
        body: fs.createReadStream(docPath),
      };
      drive.files.update({
        fileId,
        uploadType: 'media',
        resource: fileMetadata,
        media,
      }, err => {
        if (err) {
          reject(err);
        } else {
          resolve(fileId);
        }
      });
    });
  }
};

const exportToODT = async orgPath => {
  const absPath = path.resolve(resolveHome(orgPath));
  const command = `emacs ${absPath} --batch -f org-odt-export-to-odt --kill`;
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      if (stderr) {
        console.warn(stderr);
      }
      const basePath = path.join(path.dirname(absPath), path.basename(absPath, path.extname(absPath)));
      const outputPath = path.resolve(`${basePath}.odt`);
      resolve(outputPath);
    });
  });
};

const update = async (filename, docName) => {
  // eslint-disable-next-line no-console
  console.log(`updating ${docName} from ${filename}`);
  try {
    const outputPath = await exportToODT(filename);
    const oAuth2Client = await getOAuth2Client();
    await updateDocument(oAuth2Client, docName, outputPath);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
  }
};

const watchFile = (orgfilePath, docName) => {
  const watcher = fs.watch(orgfilePath, debounce(() => {
    update(orgfilePath, docName);
    // Need to start watching again, because vim renames the file to a backup and starts anew.
    watcher.close();
    watchFile(orgfilePath, docName);
  }, 500));
};

const start = () => {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    const __filename = new URL(import.meta.url).pathname;
    const scriptName = path.basename(__filename);
    // eslint-disable-next-line no-console
    console.error(`
Usage:

  ${scriptName} <google doc title> <org file path>
    `);
    return;
  }
  const docName = args[0];
  const orgfilePath = resolveHome(args[1]);
  watchFile(orgfilePath, docName);
};

start();
