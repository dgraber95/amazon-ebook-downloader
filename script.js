const { execSync } = require('child_process');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
// const puppeteer_extra = require("puppeteer-extra");
const path = require('path');
const { Webhook } = require('discord-webhook-node');
const keytar = require('keytar');
const stringSimilarity = require("string-similarity");

const AMAZON_USER_NAMESPACE = "amazon_credentials"
const AMAZON_2FA_NAMESPACE = "amazon_2fa"

const TITLES_FILE = path.join(__dirname, 'examined_titles.json'); // File containing already examined titles

let cnfg; // Global config object
let hook = null; // discord webhook (config dependent)

// Timing
const SECINMIN = 60;
const MININHR = 60;
const MSINS = 1000;
const MSINH = MSINS * SECINMIN * MININHR;

// Default configuration
const dfltCnfg = {
    "run_interval": 30,
    "headless": false,
    "browser_path": "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "downloads_dir": "",
    "return_after_hrs": 48,
    "kindle_name": "",
    "calibre_lib_path": "",
    "min_similarity": 0.4,
    // "send_to_kindle_emails": {
    //   "my_kindle_email@kindle.com": "Name of Kindle to display in Webhook message"
    // },
    // "smtp_cnfg": {
    //   "hostname": "smtp.gmail.com",
    //   "port": 587,
    //   "smtp_username": "email@gmail.com",
    //   "smtp_password": "smtp password",
    //   "encryption": "TLS",
    //   "send_from": "send_from_email@gmail.com"
    // }
  }
  
// Define log file paths
const logFilePath = path.join(__dirname, 'logs/app.log');
const errorFilePath = path.join(__dirname, 'logs/error.log');

// Create write streams for logs and errors
const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
const errorStream = fs.createWriteStream(errorFilePath, { flags: 'a' });

// Redirect console.log and console.error
console.log = (msg) => {
  logStream.write(`[${new Date().toISOString()} INFO] - ${msg}\n`);
  process.stdout.write(`${msg}\n`); // Optionally keep writing to the console
};

console.error = (msg) => {
  let message = `[${new Date().toISOString()} ERROR] - ${msg}\n`;
  errorStream.write(message);
  logStream.write(message);
  process.stderr.write(`${msg}\n`); // Optionally keep writing to the console
};

// Credential management
async function getCredentials(space, id) {
    return await keytar.getPassword(space, id);
}

async function storeCredentials(space, id, password) {
    await keytar.setPassword(space, id, password);
    console.log('Credentials stored!');
}


// Function to read the examined titles from a file
function readExaminedTitles() {
    if (fs.existsSync(TITLES_FILE)) {
        const data = fs.readFileSync(TITLES_FILE);
        return JSON.parse(data);
    }
    return {}; // Return an empty object if the file doesn't exist
}


// Function to save the updated list of titles to a file
function saveExaminedTitles(titles) {
    fs.writeFileSync(TITLES_FILE, JSON.stringify(titles, null, 2)); // Save with pretty print
}

// Get files in given folder with given extension and return full file paths
function getFilesWithExtension(folderPath, fileExtension) {
    try {
      // Read the content of the folder
      const files = fs.readdirSync(folderPath);
  
      // Filter files with the given extension and return full file paths
      const filteredFiles = files
        .filter(file => path.extname(file).toLowerCase() === fileExtension.toLowerCase())
        .map(file => path.join(folderPath, file)); // Combine folder path with file name
  
      // Return the matching files with full paths
      return filteredFiles;
    } catch (error) {
      console.error(`Error reading folder: ${error.message}`);
      return [];
    }
  }

async function runCommand(command) {
    console.debug(`Running command: ${command}`);
    try {
        const stdout = await execSync(command).toString().trim();
        return {
            success: true,
            message: '',
            stderr: '',
            stdout: stdout,
        };
    } catch (error) {
        // Capture stderr and other details from the error object
        const stderr = error.stderr ? error.stderr.toString().trim() : '';
        return {
            success: false,
            message: error.message,
            stderr: stderr,
            stdout: error.stdout ? error.stdout.toString().trim() : '',
        };
    }
}

async function getBookPath(id, libPath, format){
    // run the command to get the list of formats for the given
    // book ID
    const command = `calibredb list --with-library "${libPath}" --search "id:${id}" --fields=formats --for-machine`;
    let result = await runCommand(command);
    if(!result.success){
        console.error(result.message);
        console.error(result.stderr);
        console.error(result.stdout);
        return null
    }
    try {
        // parse JSON from query output
        let list = JSON.parse(result.stdout);
        if(list.length != 1){
            console.error(`Failed to find path for ID ${id}`);
            process.exit(-1);
        }
        const formats = list[0].formats;
        for (const f of formats) {

            if(path.extname(f) == '.' + format){
                return(f);
            }
        }
        return null;

    } catch (error) {
        return null;
    }
}

// Function to add book format to Calibre with an ID
async function addBookFormatToCalibre(bookPath, id, libPath) {
    const command = `calibredb add_format --with-library "${libPath}" "${id}" "${bookPath}"`;
    let result = await runCommand(command);
    if(!result.success){
        console.error(result.message);
        console.error(result.stderr);
        console.error(result.stdout);
        return null
    }
    return true;
}

// Function to send book to Kindle
async function sendToKindle(bookPath, kindle_email, smtp_cnfg){
    // TODO - add support for password via keytar
    const message = 'Automated email from auto_amazon_ebook_downloader'
    const command = `calibre-smtp --attachment "${bookPath}" --relay ${smtp_cnfg.hostname} --port ${smtp_cnfg.port} --username ${smtp_cnfg.smtp_username} --password "${smtp_cnfg.smtp_password}" --encryption-method ${smtp_cnfg.encryption} ${smtp_cnfg.send_from} ${kindle_email} "${message}"`
    let result = await runCommand(command);
    if(!result.success){
        console.error(result.message);
        console.error(result.stderr);
        console.error(result.stdout);
        return null
    }
    return true;
}

// Function to add book to Calibre and return the book ID
async function addBookToCalibre(bookPath, libPath) {
    const command = `calibredb add --automerge=overwrite "${bookPath}" --with-library "${libPath}"`;
    let result = await runCommand(command);
    if(!result.success){
        console.error(result.message);
        console.error(result.stderr);
        console.error(result.stdout);
        return null
    }
    try {
        // Extract the book ID from the output
        const match = result.stdout.match(/book ids?: (\d+)/);
        if (match && match[1]) {
            return parseInt(match[1], 10); // Return the book ID as an integer
        }

        return null; // Return null if no ID found
    } catch (error) {
        return null;
    }
}

// Function to convert book from azw3 to a given format
async function convertBook(bookPath, format) {
    const newPath = bookPath.replace('azw3', format)
    const command = `ebook-convert "${bookPath}" "${newPath}" --output-profile kindle_pw`;
    let result = await runCommand(command);
    if(!result.success){
        console.error(result.message);
        console.error(result.stderr);
        console.error(result.stdout);
        return null
    }
    return(newPath);
}


// wait for downloads to complete
async function waitForDownloadsToComplete(downloadPath, initialDownloads) {
    console.log(`Initially ${initialDownloads} crdownload files in ${downloadPath}`);
    return new Promise((resolve) => {
        const interval = setInterval(() => {
        const files = fs.readdirSync(downloadPath);
        const downloadingFiles = files.filter(file => file.endsWith('.crdownload'));

        if (downloadingFiles.length <= initialDownloads) {
            console.log('Done waiting for downloads');
            clearInterval(interval);
            resolve();
        }
        }, 500); // Check every 500ms
    });
}

let startTime; // Tracks when login_main started

async function login_main(page) {
    // Initialize startTime if it's not set
    if (!startTime) startTime = Date.now();

    console.log("Checking login conditions...");

    // Stop retrying after 1 minute
    if (Date.now() - startTime > 60000) {
        console.error("ERROR: Login process timed out.");
        await hook.send("ERROR: Login process timed out.");
        process.exit(1);
    }

    // Check for #auth-error-message-box
    const errorMessageBox = await page.$('#auth-error-message-box');
    if (errorMessageBox) {
        const errorMessage = await page.evaluate(el => el.innerText.trim(), errorMessageBox);
        console.error(`ERROR: Authentication error detected - ${errorMessage}`);
        await hook.send(`ERROR: Authentication error detected - ${errorMessage}`);
        process.exit(1);
    }

    // Check for .digital_entity_details and .information_row divs
    const digitalEntityDetails = await page.$('.digital_entity_details');
    const informationRow = await page.$('.information_row');
    if (digitalEntityDetails && informationRow) {
        console.log("Found .digital_entity_details and .information_row. Login successful.");
        return true;
    }

    // Check for [data-test-id="customerName"]
    const customerName = await page.$('[data-test-id="customerName"]');
    if (customerName) {
        // Use page.evaluate to click the parent element
        await page.evaluate(() => {
            const customerName = document.querySelector('[data-test-id="customerName"]');
            if (customerName) {
                const parent = customerName.parentElement;  // Get the parent element
                if (parent) {
                    parent.click();  // Click the parent
                } else {
                    console.error('Parent element not found!');
                }
            } else {
                console.error('[data-test-id="customerName"] not found!');
            }
        });

        await page.waitForNavigation({ waitUntil: 'networkidle2' }) // Wait for navigation
        await new Promise(resolve => setTimeout(resolve, 200)); // Pause before retrying
        return login_main(page);
    }

    // Check for #auth-mfa-otpcode
    const mfaCode = await page.$('#auth-mfa-otpcode');
    if (mfaCode) {
        console.error("ERROR: MFA required. Exiting process.");
        await hook.send("ERROR: MFA required. Exiting process.");
        process.exit(1);
    }

    // Check for #ap_email and #ap_password
    const emailField = await page.$('#ap_email');
    const passwordField = await page.$('#ap_password');

    if (emailField) {
        const emailFieldValue = await page.evaluate(el => el.value, emailField);

        if (!emailFieldValue) {
            console.log("Found #ap_email and it is empty. Typing email...");
            await page.type('#ap_email', cnfg.amazon_email);
        }
    }

    if (!passwordField) {
        const continueButton = await page.$('#continue');
        if (continueButton) {
            console.log("Password not present. Clicking #continue and retrying...");
            await continueButton.click();
            await page.waitForNavigation({ waitUntil: 'load' }) // Wait for navigation
            await new Promise(resolve => setTimeout(resolve, 200)); // Pause before retrying
            return login_main(page);
        }
    } else {
        console.log("Found #ap_password. Typing password");

        let password = await getCredentials(AMAZON_USER_NAMESPACE, cnfg.amazon_email);

        await page.type('#ap_password', password);
        const signInButton = await page.$('#signInSubmit');
        if (signInButton) {

            // Use page.evaluate to click the sign in button
            console.log("Submitting");
            await page.evaluate(() => {
                const signInButton = document.querySelector('#signInSubmit');
                if (signInButton) {
                    signInButton.click();  // Click the parent
                }
            });
            await page.waitForNavigation({ waitUntil: 'load' }) // Wait for navigation
        }
        await new Promise(resolve => setTimeout(resolve, 200)); // Pause before retrying
        return login_main(page);
    }

    // Fallback: Retry after 1000ms
    console.log("No matching conditions found. Retrying...");
    await new Promise(resolve => setTimeout(resolve, 1000)); // Pause before retrying
    return login_main(page);
}


function shouldReturnBook(downloadedAt) {
    const downloadedTime = new Date(downloadedAt); // Convert string to Date
    const currentTime = new Date(); // Current time
    const elapsedHours = (currentTime - downloadedTime) / (1000 * 60 * 60); // Calculate elapsed hours
    return elapsedHours >= cnfg.return_after_hrs; // Return true if elapsed time is greater than or equal to the limit
}


async function returnBook(page, book, title){
    // Get the "Return this book" div and click it
    let success = await page.evaluate(async (entity_details) => {
        // Get and click the Return button
        const span = [...entity_details.querySelectorAll('span')].find(s => s.textContent.includes('Return this book'));
        let returnButton = span ? span.parentElement : null;
        if(returnButton){
            returnButton.click();
            return true;
        }
        else{
            return false;
        }
    }, book);

    if(!success){
        console.error('ERROR: Failed to return book')
        await hook.send('ERROR: Failed to return book')
        return;
    }
    await delay(1000);

    // Confirm return
    await page.evaluate(async (entity_details) => {
        let returnConfirm = entity_details.querySelector('div[id^="RETURN_CONTENT_ACTION_"][id$="_CONFIRM"]');
        returnConfirm.click();
    }, book);
    await delay(1000);

    // close dialog
    await page.evaluate(async () => {
        document.querySelector('[id=notification-close]').click();
    });
    await delay(500);

    // tell everyone
    console.log('Returned ' + title);
    await hook.send('Returned ' + title);
}

// Function to download a single book, given
// a book title to fetch from the content page
async function downloadBook(page, book, title) {
    // Extract the second '.information_row' within this element.
    // It contains info on whether or not this is a library loan.
    const loanInfo = await page.evaluate(entity_details => {
        const rows = entity_details.querySelectorAll('.information_row');
        return rows[1] ? rows[1].textContent : '';
    }, book);
    if (!loanInfo.includes('is a Kindle digital library loan')) {
        console.error(`${title} is not available as a library loan`);
        await hook.send(`${title} is not available as a library loan`);
        process.exit(-1);
    }

    // Before attempting to download, get the existing
    // books and in progress downloads so we can compare to
    // after we expect a download
    let books_before = getFilesWithExtension(cnfg.downloads_dir, '.azw3')
    let crdl_before = getFilesWithExtension(cnfg.downloads_dir, '.crdownload').length;

    // Get the "More Actions" div and click it
    console.debug('Selecting More Actions');
    await page.evaluate(async (entity_details) => {
        const moreActionDiv = entity_details.querySelector('div[id="MORE_ACTION:false"]');
        if (moreActionDiv) {
            moreActionDiv.click();
        }
    }, book);

    await delay(500);

    // Get the descendant whose id contains 'DOWNLOAD_AND_TRANSFER_ACTION' and click it
    console.debug('Selecting Download and Transfer');
    let d_and_t = await page.$('div[id*="DOWNLOAD_AND_TRANSFER_ACTION"]');
    if (!d_and_t){
        console.error('Could not find Download and Transfer button');
        await hook.send('Could not find Download and Transfer button');
        process.exit(-1);
    }
    await page.evaluate(async (entity_details) => {
        const downloadDiv = entity_details.querySelector('div[id*="DOWNLOAD_AND_TRANSFER_ACTION"]');
        if (downloadDiv) {
            downloadDiv.click();
        }
    }, book);

    await delay(1000);

    // Select configured Kindle from the list of devices
    console.log('Selecting configured Kindle');
    await page.evaluate(async (entity_details) => {
        const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        const transferList = entity_details.querySelector('ul[id*="download_and_transfer_list"]');
        if (transferList) {
            const liElements = transferList.querySelectorAll('li');

            // Loop through each 'li' element and find the matching one
            for (let liElement of liElements) {
                const divChildren = liElement.querySelectorAll('div');
                if (divChildren.length > 1) {
                    const secondDivText = divChildren[1].innerText;

                    if (secondDivText.includes(cnfg.kindle_name)) {
                        // Select the input and click it
                        liElement.querySelector('input').click();
                        return;
                    }
                }
            }
        }
    }, book);

    await delay(1000);

    // Click download button
    console.log('Clicking Download after device selection');
    let download_button = await page.$('div[id^="DOWNLOAD_AND_TRANSFER_ACTION_"][id$="_CONFIRM"]');
    if(!download_button){
        console.error('Could not find Download button after selecting device');
        await hook.send('Could not find Download button after selecting device');
        process.exit(-1);
    }
    let success = await page.evaluate(async (entity_details) => {
        // Press download
        const downloadButton = entity_details.querySelector('div[id^="DOWNLOAD_AND_TRANSFER_ACTION_"][id$="_CONFIRM"]');
        if (downloadButton) {
            downloadButton.click();
            return true;
        }
        return false;
    }, book);
    if(success){
        console.log('Clicked Download');
    }
    else{
        console.error('Failed to click Download')
    }

    // We should be downloading now.
    // Wait for downloads to complete
    await delay(2000);
    await waitForDownloadsToComplete(cnfg.downloads_dir, crdl_before);

    // Compare the lists of books before and after
    // download. We expect there to be exactly
    // one more item than when we started.
    let books_after = getFilesWithExtension(cnfg.downloads_dir, '.azw3')
    let new_books  = books_after.filter(item => !books_before.includes(item));
    if(new_books.length < 1){
        console.error('ERROR: Failed to download ' + title)
        await hook.send('ERROR: Failed to download ' + title)
        process.exit(-1);
    }
    else if(new_books.length > 1){
        await hook.send('ERROR: Downloaded too many books somehow')
        console.error('ERROR: Downloaded too many books somehow')
        console.error(new_books)
        process.exit(-1);
    }

    // Everything probably went fine, return new book file path
    return new_books[0];
}

// Delay function to help with waits
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Gets the book entity from the set of 
// digital entity summaries on the Amazon
// books page
async function getBookEntityByTitle(page, title){
    // Get all elements with the class beginning with '.div[class^="DigitalEntitySummary-module__container"]'
    const bookEntities = await page.$$(
        'div[class^="DigitalEntitySummary-module__container"]'
    );

    // Iterate over each book entity
    let similarities = {};
    let highestSimilarity = 0;
    let bestMatch = null;
    let bestMatchBookTitle = '';
    for (const book of bookEntities) {
        // Get book title
        const bookTitle = await page.evaluate(entity_details => {
            const title = entity_details.querySelector('.digital_entity_title');
            return title ? title.textContent : '';
        }, book);
        if(!bookTitle){
            console.error('Could not find book title');
        }

        // check the similarity of this entity title to the 
        // target title. Save the similarity and entity
        // if it is higher than the highest up to this point
        const similarity = stringSimilarity.compareTwoStrings(bookTitle, title);
        if( similarity > highestSimilarity){
            highestSimilarity = similarity;
            bestMatch = book;
            bestMatchBookTitle = bookTitle;
        }
        similarities[bookTitle] = similarity;
    } // end book iter

    // if the highest similarity up to this point
    // is greater than the configured minimum
    // similarity, return the corresponding book entity. 
    // This is helpful for book series where multiple titles
    // share the same words (e.g. Harry Potter) and thus both
    // have high similarity scores - the higher one will
    // be chosen
    if(highestSimilarity > cnfg.min_similarity){
        console.log(`Found match! ${bestMatchBookTitle}`)
        console.log(`Similarity: ${similarities[bestMatchBookTitle]}`)
        return bestMatch;
    }
    
    console.log(`No entity match - similarities:`);
    console.log(Object.entries(similarities));
    return null
} // getBookEntityByTitle

// Function to download books
async function downloadBooks(page, examinedTitles, toDownload) {

    let addedTitles = {}

    // Get all elements with the class beginning with '.div[class^="DigitalEntitySummary-module__container"]'
    const bookEntities = await page.$$(
        'div[class^="DigitalEntitySummary-module__container"]'
    );

    // Iterate over each book entity
    for (const book of bookEntities) {
        // Get the initial azw3 files in the downloads folder
        let books_before = getFilesWithExtension(cnfg.downloads_dir, '.azw3')

        // Get the number of crdownload files before
        let crdl_before = getFilesWithExtension(cnfg.downloads_dir, '.crdownload').length;

        // Attempt to download the book
        let title = await downloadBook(page, book, examinedTitles);
        if(!title){
            continue;
        }

        // Wait for downloads to complete
        console.log('Waiting ten seconds');
        await delay(10000);
        console.log('Done waiting ten seconds');
        await waitForDownloadsToComplete(cnfg.downloads_dir, crdl_before);

        // Get the azw3 files in the downloads folder after download
        let books_after = getFilesWithExtension(cnfg.downloads_dir, '.azw3')
        
        // Compare the lists of books before and after
        // download. We expect there to be exactly
        // one more item than when we started.
        let new_books  = books_after.filter(item => !books_before.includes(item));
        if(new_books.length < 1){
            console.error('ERROR: Failed to download ' + title)
            await hook.send('ERROR: Failed to download ' + title)
            process.exit(-1);
        }
        else if(new_books.length > 1){
            console.error('ERROR: Downloaded too many books somehow')
            console.error(new_books)
            process.exit(-1);
        }

        // Build object
        addedTitles[title] = {
            title: title,
            downloaded_at: new Date().toISOString(), // Store the current time
            file_path: new_books[0]
        };
        console.log('Downloaded ' + title + ' (' + addedTitles[title].file_path + ')');


        console.log('Simulating adding to calibre');


        // Add the book to calibre
        if(addBookToCalibre(addedTitles[title].file_path, cnfg.calibre_lib_path) == true){
            // Success - now delete the file
            console.log('Deleting ' + addedTitles[title].file_path)
            fs.unlinkSync(addedTitles[title].file_path)
            await hook.send('Added ' + title);

            // Return here because Chrome seems to get angry 
            // about downloading multiple files in the same session.
            // We'll get the others on another loop.
            Object.assign(examinedTitles, addedTitles);
            saveExaminedTitles(examinedTitles);
            return;
        }
        else{
            console.error('Failed to import ' + title + ' ( ' + addedTitles[title].file_path + ')');
            await hook.send('Failed to import ' + title + ' ( ' + addedTitles[title].file_path + ')');
        }
    } // end book iter

    Object.assign(examinedTitles, addedTitles);

    // Send discord stats
    if(Object.keys(addedTitles).length == 0) {
        console.log('No new books found');
    }

    saveExaminedTitles(examinedTitles);
}


async function getLibbyLoans() {
    // First, get the latest loan information from libby
    const loan_info_json = 'libby_loan_info.json'
    let result = await runCommand(`odmpy libby --ebooks --exportloans ${loan_info_json}`);
    if(result.success == true){
        console.debug(`Successfully retrieved latest Libby loan info (${loan_info_json})`)
    }
    else{
        if ((result.stderr + result.stdout).includes('chip/sync')){
            await runCommand(`odmpy libby --reset`);
            await hook.send('Amazon eBook Downloader - new Libby code required');
            let result = await runCommand(`odmpy libby`);


        }


        console.error('Failed to retrieve latest Libby loan info');
        // await hook.send('Failed to retrieve latest Libby loan info');
        return [];
    }

    // Next, read in the updated loan info JSON file and
    // filter results by Amazon ebook
    let libby_ebooks = []
    try {
        let loans = JSON.parse(fs.readFileSync(loan_info_json, 'utf8'));
        // Extract the required information
        loans.forEach(loan => {
            // Check for Kindle format in formats
            const hasKindleFormat = loan.formats.some(format => format.id === 'ebook-kindle');
            if(hasKindleFormat){
                libby_ebooks.push(loan.sortTitle);
                console.log(`Title: ${loan.sortTitle}`);
            }
        });

    } catch (parseErr) {
        console.error('Error parsing the JSON data:', parseErr);
        await hook.send('Failed to parse latest Libby loan info');
        process.exit(-1);
    }



    // fs.readFileSync(loan_info_json, 'utf8', (err, data) => {
    //     if (err) {
    //         console.error('Failed to read latest Libby loan info');
    //         await hook.send('Failed to read latest Libby loan info');
    //         process.exit(-1);
    //     }
    //     try {
    //         // Parse the JSON data
    //         const loans = JSON.parse(data);

    //         // Extract the required information
    //         loans.forEach(loan => {
    //             // Check for Kindle format in formats
    //             const hasKindleFormat = loan.formats.some(format => format.id === 'ebook-kindle');
    //             if(hasKindleFormat){
    //                 libby_ebooks.push(loan.title);
    //                 console.log(`Title: ${loan.title}`);
    //             }
    //         });
    
    //     } catch (parseErr) {
    //         console.error('Error parsing the JSON data:', parseErr);
    //         await hook.send('Failed to parse latest Libby loan info');
    //         process.exit(-1);
    //     }
    // });

    return libby_ebooks;
}

async function getNewLibbyLoans(libby_ebooks, examinedTitles){
    let new_books  = libby_ebooks.filter(title => !examinedTitles[title]);
    if(new_books.length > 0){
        console.log('New books!');
        console.log(new_books);
    }
    return(new_books);
}

async function openBooksPage(){
    const browser = await puppeteer.launch({
        headless: cnfg.headless,
        timeout: 60000, // Increase the launch timeout (default is 30,000 ms)
        devtools: true,   // Open DevTools automatically
        executablePath: cnfg.browser_path
     });
    const page = await browser.newPage();

    // Get the dimensions of the screen
    const { width, height } = await page.evaluate(() => ({
        width: window.screen.width,
        height: window.screen.height,
    }));

    // Resize the window to full screen size minus taskbar height
    await page.setViewport({ width, height: height - 80 }); // Adjust height as necessary

    // Load cookies from the saved file
    const cookies = JSON.parse(fs.readFileSync(path.join(__dirname, 'cookies.json')));
    await page.setCookie(...cookies);

    // Navigate to content library
    await page.goto('https://www.amazon.com/hz/mycd/digital-console/contentlist/booksAll/dateDsc/');

    return {browser: browser, page: page}
}

// Main
async function main() {
    const now = new Date();
    const formattedDateTime = now.toLocaleString();
    console.log(`Starting run (${formattedDateTime})`);

    // Read the previously examined titles
    let examinedTitles = readExaminedTitles();

    // First, check to see if libby has any new loans.
    // May need to run odmpy libby first to log in
    const libby_ebooks = await getLibbyLoans();
    let new_libby_ebooks = [];
    if(libby_ebooks.length >= 1){
        new_libby_ebooks = await getNewLibbyLoans(libby_ebooks, examinedTitles);
        if(new_libby_ebooks.length < 1){
            console.log('No new loans found.');
        }
    }

    // Iterate over each new book and create a browser
    // instance to download them individually. I haven't
    // figured out how to get Chrome to download multiple
    // files automatically
    for (const new_book of new_libby_ebooks) {
        // const browser = await puppeteer.launch({
        //     headless: cnfg.headless,
        //     timeout: 60000, // Increase the launch timeout (default is 30,000 ms)
        //     devtools: true,   // Open DevTools automatically
        //     executablePath: cnfg.browser_path
        //  });
        // const page = await browser.newPage();
    
        // // Get the dimensions of the screen
        // const { width, height } = await page.evaluate(() => ({
        //     width: window.screen.width,
        //     height: window.screen.height,
        // }));
    
        // // Resize the window to full screen size minus taskbar height
        // await page.setViewport({ width, height: height - 80 }); // Adjust height as necessary
    
        // // Load cookies from the saved file
        // const cookies = JSON.parse(fs.readFileSync(path.join(__dirname, 'cookies.json')));
        // await page.setCookie(...cookies);
    
        // // Navigate to content library
        // await page.goto('https://www.amazon.com/hz/mycd/digital-console/contentlist/booksAll/dateDsc/');

        let {browser, page} = await openBooksPage();
    
        startTime = 0;
        let logged_in = await login_main(page, examinedTitles);
        if(logged_in == false){
            console.error(`Failed to log in`);
            await hook.send(`Failed to log in`);
            process.exit(-1);
        }

        // First, get the book entity
        let book_entity = await getBookEntityByTitle(page, title=new_book);
        if(!book_entity){
            console.log(`Could not find entity for ${new_book}. May not have been added to Amazon yet.`);
            try{
                await browser.close();
            }
            catch(error){
                console.log('Who cares.');
            }
            continue;
        }
        
        // next, try to download title
        let downloaded_ebook_path = await downloadBook(page, book_entity, title=new_book)
        if(!downloaded_ebook_path){
            console.error(`Failed to import ${downloaded_ebook_path}`);
            await hook.send(`Failed to import ${downloaded_ebook_path}`);
            process.exit(-1);
        }

        // Got a download path. Attempt to add it to Calibre.
        let added_id = await addBookToCalibre(downloaded_ebook_path, cnfg.calibre_lib_path);
        if(!added_id){
            console.error(`Failed to import ${downloaded_ebook_path}`);
            await hook.send(`Failed to import ${downloaded_ebook_path}`);
            process.exit(-1);
        }

        // Convert the book to epub
        let converted_path = await convertBook(downloaded_ebook_path, 'epub');
        if(!converted_path){
            console.error(`Failed to convert ${downloaded_ebook_path}`);
            await hook.send(`Failed to convert ${downloaded_ebook_path}`);
            process.exit(-1);
        }

        // Add the converted book to Calibre using
        // the ID from the initial add
        let success = await addBookFormatToCalibre(converted_path, added_id, cnfg.calibre_lib_path);
        if(!success){
            console.error(`Failed to import converted ${converted_path}`);
            await hook.send(`Failed to import converted ${converted_path}`);
            process.exit(-1);
        }

        // Get the epub path from the book we just added.
        // We can use this to save to examinedTitles
        // and also for emailing later on.
        let epub_path = await getBookPath(added_id, cnfg.calibre_lib_path, 'epub');
        if(!epub_path){
            console.error(`Failed to get converted book path for ${new_book}`);
            await hook.send(`Failed to get converted book path for ${new_book}`);
            process.exit(-1);
        }

        // Successfully added epub to Calibre. Add it to
        // examined titles.
        examinedTitles[new_book] = {
            title: new_book,
            downloaded_at: new Date().toISOString(), // Store the current time
            file_path: epub_path,
            id: added_id
        };
        saveExaminedTitles(examinedTitles);

        // Check if there are any emails to send the book to
        let kindle_emails = cnfg.send_to_kindle_emails;
        if(kindle_emails){
            for (const email in kindle_emails){
                console.log(`Sending to ${kindle_emails[email]}`);
                await sendToKindle(epub_path, email, cnfg.smtp_cnfg);
                console.log(`Success!`);
                hook.send(`Delivered ${new_book} to ${kindle_emails[email]}`);
            }
        }

        try{
            await browser.close();
        }
        catch(error){
            console.log('Who cares.');
        }
      }


    // Iterate over all the examined titles to see if it
    // is time to return any of them
    for (const exTitle in examinedTitles) {
        book = examinedTitles[exTitle];

        if(book.returned_at){
            continue;
        }

        if(shouldReturnBook(book.downloaded_at)){

            // Time to return it, create a new browser & page
            // let browser = null;
            // let page = null;
            let {browser, page} = await openBooksPage();

            // Try to log in
            startTime = 0;
            let logged_in = await login_main(page, examinedTitles);
            if(logged_in == false){
                console.error(`Failed to log in`);
                await hook.send(`Failed to log in`);
                process.exit(-1);
            }
        
            // Get the book entity
            let book_entity = await getBookEntityByTitle(page, book.title);
            if(!book_entity){
                console.log(`Could not find entity for ${new_book}. May have been returned already.`);
            }
            else{
                // Return it!
                await returnBook(page, book_entity, book.title);
            }

            // Remove the book from examined titles and 
            // update them
            examinedTitles[book.title].returned_at = new Date().toISOString();
            saveExaminedTitles(examinedTitles);
            try{
                await browser.close();
            }
            catch(error){
                console.log('Who cares.');
            }
        }
    }

}

// validate the given config key
async function validateConfig(key, value) {
    switch(key){
        case "run_interval":
            if(value < 0){
                console.error(`Invalid run interval ${value} (must be positive)`);
                process.exit(-1);
            }
            break;

        case "browser_path":
            if (!fs.existsSync(value)) {
                console.error(`Could not locate browser at "${value}". Update path in config.json.`);
                process.exit(-1);
            }
            break;
        
        case "downloads_dir":
            if (!fs.existsSync(value)) {
                console.error(`Could not locate directory at "${value}". Update path in config.json.`);
                process.exit(-1);
            }
            break;

        case "discord_webhook":
            if(!hook && value){
                console.debug('Creating Discord webhook');
                hook = new Webhook(value);
            }
            process.exit(-1)
        default:
            break;
    }
}

// Load config dynamically
async function loadConfig() {
    try {
        const configPath = path.join(__dirname, 'config.json');
        // cnfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));

        if (fs.existsSync(configPath)) {
            console.log('Found config file');
        } 
        else {
            console.log('Creating config file');
            fs.writeFileSync(configPath, JSON.stringify(dfltCnfg, null, 2)); // Save with pretty print
        }

        cnfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        for (const [key, value] of Object.entries(cnfg)) {
            await validateConfig(key, value);
        }

        process.exit(0)

        if(!hook && cnfg.discord_webhook){
            hook = new Webhook(cnfg.discord_webhook);
        }
    } catch (error) {
        console.error('Failed to load config:', error);
        await hook.send('Failed to load config:', error);
        process.exit(1); // Exit on critical error
    }
}

async function executeMain() {
    await loadConfig();
    await main();
    console.log('Next iteration in ' + cnfg.run_interval + 's');
    setTimeout(executeMain, cnfg.run_interval * MSINS);
}


(async () => {
    console.log('Starting downloader');

    try {
    // Start the process
    executeMain();
    } catch (error) {
        console.log(`ERROR: ${error}`);
        await hook.send('Auto Amazon eBook Downloader error');
        process.exit(-1);
    }

})();