const CONFIG = {
  calendarId: '72f6cef4f526b2c11fe979aafa2d98005f1571a55d06f4c1179137ce8f0a23b9@group.calendar.google.com',
  sheetId: '1xvK-sf6WGiCkD0vhi9CVjNTRtM2Hff7VjYTDxJ1IDzw',
  sheetName: 'Directory',
  cloudRunUrl: 'https://midwivesoncall-1074467807545.us-central1.run.app/run'
};

// ================= WEB APP ENTRYPOINTS =================
function doPost(e) {
  try {
    const body = e && e.postData && e.postData.contents
      ? JSON.parse(e.postData.contents)
      : {};

    const action = String(body.action || '').trim();

    if (!action) {
      return jsonResponse({
        ok: false,
        phase: 'unknown',
        message: 'Missing action'
      });
    }

    let result;

    if (action === 'precheck') {
      result = precheckOnCallUpdate();
    } else if (action === 'execute') {
      result = executeOnCallUpdate();
    } else if (action === 'retry1') {
      result = retryOnCallUpdate1();
    } else if (action === 'retry2') {
      result = retryOnCallUpdate2();
    } else {
      result = {
        ok: false,
        phase: action,
        message: 'Unknown action: ' + action
      };
    }

    return jsonResponse(result);
  } catch (err) {
    return jsonResponse({
      ok: false,
      phase: 'doPost',
      message: 'Unhandled doPost error',
      error: String(err)
    });
  }
}

function doGet() {
  return jsonResponse({
    ok: true,
    phase: 'health',
    message: 'Apps Script web app is running'
  });
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ================= DAILY OPERATIONAL FLOWS =================
function precheckOnCallUpdate() {
  const phase = 'precheck';

  try {
    const today = getTodayOnCallPerson();
    const next = getNextOnCallPerson();
    const recipients = getAlertRecipients(today, next);

    const result = triggerCloudRun(today.hotelingHours, true, 'precheck');

    if (isCloudRunSuccess(result)) {
      setExecutionState('PRECHECK_OK', 'YES');
      setExecutionState('PRECHECK_TS', new Date().toISOString());

      Logger.log('Precheck succeeded');
      Logger.log(result.body);

      return {
        ok: true,
        phase: phase,
        message: 'Precheck succeeded',
        todayPersonId: today.id,
        nextPersonId: next ? next.id : '',
        details: result
      };
    }

    setExecutionState('PRECHECK_OK', 'NO');
    setExecutionState('PRECHECK_TS', new Date().toISOString());

    const subject = 'URGENT. On call automation precheck failed';
    const body = buildFailureMessage({
      phase: 'Precheck',
      retryNumber: 0,
      todayPerson: today,
      nextPerson: next,
      result: result
    });

    sendEmailList(recipients, subject, body);
    Logger.log(body);

    return {
      ok: false,
      phase: phase,
      message: 'Precheck failed',
      todayPersonId: today.id,
      nextPersonId: next ? next.id : '',
      details: result
    };
  } catch (e) {
    const today = safeGetTodayOnCallPerson();
    const next = safeGetNextOnCallPerson();
    const recipients = getAlertRecipients(today, next);

    setExecutionState('PRECHECK_OK', 'NO');
    setExecutionState('PRECHECK_TS', new Date().toISOString());

    const subject = 'URGENT. On call automation precheck failed';
    const body =
      'Phase: Precheck\n' +
      'Retry number: 0\n' +
      'Timestamp: ' + new Date() + '\n\n' +
      'Current on call:\n' +
      formatPersonForEmail(today) + '\n\n' +
      'Next on call:\n' +
      formatPersonForEmail(next) + '\n\n' +
      'Error:\n' + e;

    sendEmailList(recipients, subject, body);
    Logger.log(body);

    return {
      ok: false,
      phase: phase,
      message: 'Precheck threw exception',
      error: String(e)
    };
  }
}

function executeOnCallUpdate() {
  return runRealUpdateAttempt(0);
}

function retryOnCallUpdate1() {
  if (getExecutionState('EXECUTE_OK') === 'YES') {
    Logger.log('Retry 1 skipped because execution already succeeded');
    return {
      ok: true,
      phase: 'retry1',
      message: 'Retry 1 skipped because execution already succeeded'
    };
  }

  return runRealUpdateAttempt(1);
}

function retryOnCallUpdate2() {
  if (getExecutionState('EXECUTE_OK') === 'YES') {
    Logger.log('Retry 2 skipped because execution already succeeded');
    return {
      ok: true,
      phase: 'retry2',
      message: 'Retry 2 skipped because execution already succeeded'
    };
  }

  return runRealUpdateAttempt(2);
}

function runRealUpdateAttempt(retryNumber) {
  const phase = retryNumber === 0 ? 'execute' : 'retry' + retryNumber;

  try {
    const today = getTodayOnCallPerson();
    const next = getNextOnCallPerson();
    const recipients = getAlertRecipients(today, next);

    writeTodayHotelingHoursToAutomationTab();
    sendDailyOnCallNotifications();

    const result = triggerCloudRun(
      today.hotelingHours,
      false,
      retryNumber === 0 ? 'execute' : 'retry-' + retryNumber
    );

    if (isCloudRunSuccess(result)) {
      setExecutionState('EXECUTE_OK', 'YES');
      setExecutionState('EXECUTE_TS', new Date().toISOString());
      setExecutionState('LAST_SUCCESS_RETRY', String(retryNumber));

      Logger.log('Execution succeeded');
      Logger.log(result.body);

      return {
        ok: true,
        phase: phase,
        message: 'Execution succeeded',
        retryNumber: retryNumber,
        todayPersonId: today.id,
        nextPersonId: next ? next.id : '',
        details: result
      };
    }

    setExecutionState('EXECUTE_OK', 'NO');
    setExecutionState('EXECUTE_TS', new Date().toISOString());

    const subject = 'URGENT. On call automation update failed';
    const body = buildFailureMessage({
      phase: retryNumber === 0 ? 'Execution' : 'Retry',
      retryNumber: retryNumber,
      todayPerson: today,
      nextPerson: next,
      result: result
    });

    sendEmailList(recipients, subject, body);
    Logger.log(body);

    return {
      ok: false,
      phase: phase,
      message: 'Execution failed',
      retryNumber: retryNumber,
      todayPersonId: today.id,
      nextPersonId: next ? next.id : '',
      details: result
    };
  } catch (e) {
    const today = safeGetTodayOnCallPerson();
    const next = safeGetNextOnCallPerson();
    const recipients = getAlertRecipients(today, next);

    setExecutionState('EXECUTE_OK', 'NO');
    setExecutionState('EXECUTE_TS', new Date().toISOString());

    const subject = 'URGENT. On call automation update failed';
    const body =
      'Phase: ' + (retryNumber === 0 ? 'Execution' : 'Retry') + '\n' +
      'Retry number: ' + retryNumber + '\n' +
      'Timestamp: ' + new Date() + '\n\n' +
      'Current on call:\n' +
      formatPersonForEmail(today) + '\n\n' +
      'Next on call:\n' +
      formatPersonForEmail(next) + '\n\n' +
      'Error:\n' + e;

    sendEmailList(recipients, subject, body);
    Logger.log(body);

    return {
      ok: false,
      phase: phase,
      message: 'Execution threw exception',
      retryNumber: retryNumber,
      error: String(e)
    };
  }
}

// ================= DAILY NOTIFICATIONS =================
function sendDailyOnCallNotifications() {
  const person = getTodayOnCallPerson();
  const data = getSheetData();

  const admins = data
    .filter(p => p.admin === 'YES' && p.email)
    .map(p => p.email);

  const now = new Date();

  const adminMessage =
    'Daily On Call Confirmation\n\n' +
    'ID: ' + person.id + '\n' +
    'Name: ' + person.name + '\n' +
    'Phone: ' + person.phone + '\n' +
    'Email: ' + person.email + '\n' +
    'HotelingHours: ' + person.hotelingHours + '\n' +
    'Time: ' + now;

  const midwifeMessage =
    'You are on call today\n\n' +
    'Name: ' + person.name + '\n' +
    'Phone: ' + person.phone + '\n' +
    'HotelingHours: ' + person.hotelingHours + '\n' +
    'Time: ' + now;

  admins.forEach(email => {
    sendEmail(email, 'Daily On Call Confirmation', adminMessage);
  });

  if (person.email) {
    sendEmail(person.email, 'You are on call today', midwifeMessage);
  }
}

// ================= CLOUD RUN =================
function triggerCloudRun(hotelingHours, dryRun, traceLabel) {
  const payload = {
    hotelingHours: String(hotelingHours),
    dryRun: Boolean(dryRun),
    traceLabel: String(traceLabel || '')
  };

  const response = UrlFetchApp.fetch(CONFIG.cloudRunUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  return {
    statusCode: response.getResponseCode(),
    body: response.getContentText()
  };
}

function isCloudRunSuccess(result) {
  if (!result) return false;
  if (result.statusCode < 200 || result.statusCode >= 300) return false;

  try {
    const parsed = JSON.parse(result.body);
    return parsed && parsed.ok === true;
  } catch (e) {
    return false;
  }
}

// ================= EXECUTION STATE =================
function getExecutionStateKey(name) {
  return 'ONCALL_' + getDateKey() + '_' + name;
}

function setExecutionState(name, value) {
  PropertiesService.getScriptProperties().setProperty(getExecutionStateKey(name), String(value));
}

function getExecutionState(name) {
  return PropertiesService.getScriptProperties().getProperty(getExecutionStateKey(name));
}

function getDateKey() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd');
}

// ================= PERSON HELPERS =================
function getTodayHotelingHours() {
  const person = getTodayOnCallPerson();

  if (!person.hotelingHours) {
    throw new Error('No HotelingHours value found for ID: ' + person.id);
  }

  Logger.log('Today on call ID: ' + person.id);
  Logger.log('HotelingHours: ' + person.hotelingHours);

  return person.hotelingHours;
}

function getTodayOnCallPerson() {
  const calendar = CalendarApp.getCalendarById(CONFIG.calendarId);

  if (!calendar) {
    throw new Error('Calendar not found');
  }

  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0);
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);

  const events = calendar.getEvents(start, end);

  let detectedId = null;

  for (const event of events) {
    if (!event.isAllDayEvent()) continue;

    const title = event.getTitle().trim();
    const match = title.match(/^(.+?)\s+call$/i);

    if (match) {
      detectedId = match[1].trim().toUpperCase();
      break;
    }
  }

  if (!detectedId) {
    throw new Error('No on call event found today');
  }

  const data = getSheetData();
  const person = data.find(p => p.id === detectedId && p.active === 'YES');

  if (!person) {
    throw new Error('No matching active person found for ID: ' + detectedId);
  }

  return person;
}

function getNextOnCallPerson() {
  const calendar = CalendarApp.getCalendarById(CONFIG.calendarId);

  if (!calendar) {
    throw new Error('Calendar not found');
  }

  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 30, 23, 59, 59);

  const events = calendar.getEvents(start, end);
  const data = getSheetData();

  for (const event of events) {
    if (!event.isAllDayEvent()) continue;

    const title = event.getTitle().trim();
    const match = title.match(/^(.+?)\s+call$/i);

    if (!match) continue;

    const detectedId = match[1].trim().toUpperCase();
    const person = data.find(p => p.id === detectedId && p.active === 'YES');

    if (person) {
      return person;
    }
  }

  return null;
}

function safeGetTodayOnCallPerson() {
  try {
    return getTodayOnCallPerson();
  } catch (e) {
    return null;
  }
}

function safeGetNextOnCallPerson() {
  try {
    return getNextOnCallPerson();
  } catch (e) {
    return null;
  }
}

// ================= ALERT HELPERS =================
function getAlertRecipients(todayPerson, nextPerson) {
  const data = getSheetData();
  const recipients = [];

  data.forEach(p => {
    if (p.admin === 'YES' && p.email) {
      recipients.push(p.email);
    }
  });

  if (todayPerson && todayPerson.email) {
    recipients.push(todayPerson.email);
  }

  if (nextPerson && nextPerson.email) {
    recipients.push(nextPerson.email);
  }

  return dedupeEmails(recipients);
}

function dedupeEmails(emails) {
  const seen = {};
  const result = [];

  emails.forEach(email => {
    const key = String(email || '').trim().toLowerCase();
    if (!key) return;
    if (seen[key]) return;
    seen[key] = true;
    result.push(email);
  });

  return result;
}

function formatPersonForEmail(person) {
  if (!person) {
    return 'Not found';
  }

  return (
    'ID: ' + person.id + '\n' +
    'Name: ' + person.name + '\n' +
    'Phone: ' + person.phone + '\n' +
    'Email: ' + person.email + '\n' +
    'HotelingHours: ' + person.hotelingHours
  );
}

function buildFailureMessage(args) {
  return (
    'Phase: ' + args.phase + '\n' +
    'Retry number: ' + args.retryNumber + '\n' +
    'Timestamp: ' + new Date() + '\n\n' +
    'Current on call:\n' +
    formatPersonForEmail(args.todayPerson) + '\n\n' +
    'Next on call:\n' +
    formatPersonForEmail(args.nextPerson) + '\n\n' +
    'Cloud Run status code: ' + args.result.statusCode + '\n' +
    'Cloud Run body:\n' + args.result.body
  );
}

// ================= SHEET =================
function getSheetData() {
  const sheet = SpreadsheetApp.openById(CONFIG.sheetId).getSheetByName(CONFIG.sheetName);
  const rows = sheet.getDataRange().getValues();

  const data = [];

  for (let i = 1; i < rows.length; i++) {
    data.push({
      id: String(rows[i][0] || '').trim().toUpperCase(),
      name: rows[i][1],
      phone: String(rows[i][2] || '').trim(),
      email: String(rows[i][3] || '').trim(),
      active: String(rows[i][4] || '').trim().toUpperCase(),
      admin: String(rows[i][5] || '').trim().toUpperCase(),
      hotelingHours: String(rows[i][6] || '').trim()
    });
  }

  return data;
}

// ================= AUTOMATION TAB =================
function writeTodayHotelingHoursToAutomationTab() {
  const ss = SpreadsheetApp.openById(CONFIG.sheetId);
  const sheet = ss.getSheetByName('Automation');

  if (!sheet) {
    throw new Error('Automation tab not found');
  }

  const person = getTodayOnCallPerson();

  sheet.getRange('A1').setValue('OnCallID');
  sheet.getRange('B1').setValue(person.id);

  sheet.getRange('A2').setValue('HotelingHours');
  sheet.getRange('B2').setValue(person.hotelingHours);

  sheet.getRange('A3').setValue('UpdatedAt');
  sheet.getRange('B3').setValue(new Date());

  Logger.log('Wrote HotelingHours to Automation tab: ' + person.hotelingHours);
}

// ================= EMAIL =================
function sendEmail(to, subject, body) {
  try {
    MailApp.sendEmail(to, subject, body);
    Logger.log('Email sent to ' + to);
  } catch (e) {
    Logger.log('Email error: ' + e);
  }
}

function sendEmailList(recipients, subject, body) {
  recipients.forEach(email => {
    sendEmail(email, subject, body);
  });
}

// ================= TESTS =================
function testCloudRunOnly() {
  const person = getTodayOnCallPerson();
  const result = triggerCloudRun(person.hotelingHours, false, 'manual-test');
  Logger.log('Status Code: ' + result.statusCode);
  Logger.log('Body: ' + result.body);
}

function testCloudRunDryRunOnly() {
  const person = getTodayOnCallPerson();
  const result = triggerCloudRun(person.hotelingHours, true, 'manual-dry-run');
  Logger.log('Status Code: ' + result.statusCode);
  Logger.log('Body: ' + result.body);
}

function testWriteAutomationTabAndCloudRun() {
  writeTodayHotelingHoursToAutomationTab();
  const person = getTodayOnCallPerson();
  const result = triggerCloudRun(person.hotelingHours, false, 'manual-write-and-run');
  Logger.log('Status Code: ' + result.statusCode);
  Logger.log('Body: ' + result.body);
}

function testPrecheck() {
  const result = precheckOnCallUpdate();
  Logger.log(JSON.stringify(result));
}

function testExecute() {
  const result = executeOnCallUpdate();
  Logger.log(JSON.stringify(result));
}

function testRetry1() {
  const result = retryOnCallUpdate1();
  Logger.log(JSON.stringify(result));
}

function testRetry2() {
  const result = retryOnCallUpdate2();
  Logger.log(JSON.stringify(result));
}

// ================= RESET =================
function resetState() {
  PropertiesService.getScriptProperties().deleteAllProperties();
  Logger.log('State cleared');
}
