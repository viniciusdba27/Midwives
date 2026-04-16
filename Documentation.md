# Midwives On Call Automation System

## Overview

This system automates daily on call coordination for a midwifery practice.

It connects four operational layers:

1. Google Calendar for the source of truth about who is on call.
2. Google Sheets for the directory of midwives, active flags, admin flags, and Hoteling Hours values.
3. Google Apps Script for business logic, notifications, and orchestration support.
4. Google Cloud Run plus Playwright for secure browser automation into the Rogers portal.

The system exists to reduce manual work, prevent missed call routing changes, and provide controlled retries and alerts when something fails.

## Why this system exists

The main business goal is simple:

The correct midwife must receive calls on the correct day.

To support that goal, the system does all of the following:

1. Reads the on call calendar.
2. Confirms who is on call today.
3. Reads that person’s Hoteling Hours from the directory spreadsheet.
4. Updates the Rogers portal automatically.
5. Sends operational email notifications.
6. Performs a precheck before the real update.
7. Runs retries after the main update if needed.
8. Prevents inactive people from being used in the automation.

## Core personas

### 1. Midwife currently on call

This person cares about receiving calls properly and receiving the correct on call notification.

Main interactions:

1. Receives the daily on call email.
2. Is affected by the Rogers routing update.
3. Receives alert emails if there is a failure.

### 2. Next on call midwife

This person is not the main recipient of the routing change, but should be informed if there is a system failure that could affect the transition to the next shift.

Main interactions:

1. Receives failure alerts when the system cannot guarantee a correct update.

### 3. Admin or coordinator

This person manages schedules and operational data, usually without needing to touch code.

Main interactions:

1. Updates the Directory spreadsheet.
2. Maintains active flags and admin flags.
3. Updates the calendar if needed.
4. Receives daily confirmations and failure alerts.

### 4. System owner

This is the person responsible for the deployed solution in production.

Main interactions:

1. Owns the Apps Script project.
2. Owns or manages the production spreadsheet.
3. Can review executions, logs, and alerts.
4. Can force test runs when needed.

### 5. Developer

This person builds and improves the automation.

Main interactions:

1. Maintains Cloud Run code.
2. Maintains Apps Script code.
3. Adjusts selectors if the Rogers portal changes.
4. Improves reliability, monitoring, and documentation.

### 6. Google Workspace admin

This person is not necessarily technical, but may be needed to grant access or remove restrictions.

Main interactions:

1. Grants calendar and spreadsheet access if needed.
2. Makes sure the script owner can authorize Apps Script services.
3. May help when Workspace restrictions block authorization.

### 7. Google Cloud operator

This person manages the cloud side of the system.

Main interactions:

1. Deploys Cloud Run.
2. Configures environment variables.
3. Manages Cloud Scheduler jobs.
4. Reviews Cloud Run logs and Scheduler job history.

### 8. External dependency. Rogers portal

This is not a person, but it is a critical dependency.

The automation depends on this portal being reachable and having a compatible UI structure.

## High level architecture

```text
Google Calendar
   |
   v
Google Apps Script
   |
   v
Google Cloud Run /orchestrate
   |
   v
Google Apps Script business action
   |
   v
Google Cloud Run /run
   |
   v
Playwright browser automation
   |
   v
Rogers Portal
```

## Main system components

### 1. Google Calendar

Purpose:

1. Holds the daily on call schedule.
2. Acts as the source of truth for who is on call today.

Expected event pattern:

```text
NAME call
```

Examples:

```text
VINICIUS call
MARIA call
```

Important rule:

Only all day events are considered valid by the current logic.

### 2. Google Sheets

The spreadsheet contains operational configuration.

#### Directory tab

This tab contains the midwife directory and flags used by the script.

Expected columns:

| Column | Meaning |
|---|---|
| A | ID |
| B | Name |
| C | Phone |
| D | Email |
| E | Active |
| F | Admin |
| G | HotelingHours |

Important rules:

1. `Active` must be `YES` for a person to be eligible for the automation.
2. `Admin` should be `YES` for users who must receive admin alerts.
3. `HotelingHours` must exist for the current on call person.

#### Automation tab

This tab is used as a simple operational scratchpad.

Expected values written by the script:

| Cell | Meaning |
|---|---|
| A1 | OnCallID |
| B1 | Current on call ID |
| A2 | HotelingHours |
| B2 | Current on call HotelingHours |
| A3 | UpdatedAt |
| B3 | Timestamp of latest update |

### 3. Google Apps Script

Purpose:

1. Reads the calendar.
2. Reads the spreadsheet.
3. Sends email notifications.
4. Calls Cloud Run.
5. Handles precheck, execution, and retry orchestration at the business level.

Important functions:

| Function | Purpose |
|---|---|
| `precheckOnCallUpdate` | Runs dry run validation |
| `executeOnCallUpdate` | Runs the real update |
| `retryOnCallUpdate1` | Runs retry 1 if needed |
| `retryOnCallUpdate2` | Runs retry 2 if needed |
| `getTodayOnCallPerson` | Finds the active person on call today |
| `getNextOnCallPerson` | Finds the next active person in the future calendar |
| `triggerCloudRun` | Calls Cloud Run `/run` |
| `doPost` | Receives requests from Cloud Run `/orchestrate` |

### 4. Cloud Run

Purpose:

1. Provides a stable HTTP API for Cloud Scheduler.
2. Calls Apps Script and translates the result into clean HTTP success or failure codes.
3. Runs the Playwright automation for Rogers.

Important routes:

| Route | Purpose |
|---|---|
| `GET /` | Health response |
| `POST /run` | Direct Rogers update or dry run |
| `POST /orchestrate` | Orchestration route called by Cloud Scheduler |

### 5. Playwright automation

Purpose:

1. Logs in to Rogers.
2. Navigates to the correct user services page.
3. Finds the Hoteling Guest modal.
4. Validates or updates Hoteling Hours.

Important note:

This is the part most exposed to portal UI changes.

### 6. Cloud Scheduler

Purpose:

Runs exact timed phases for the workflow.

Expected schedule:

| Time | Job | Action |
|---|---|---|
| 07:00 | Precheck | `precheck` |
| 07:30 | Execute | `execute` |
| 07:40 | Retry 1 | `retry1` |
| 07:50 | Retry 2 | `retry2` |

Recommended timezone:

```text
America/Vancouver
```

## End to end daily workflow

### 1. Precheck at 07:00

Purpose:

1. Validate that the Rogers portal can be reached.
2. Confirm the Hoteling Guest path is accessible.
3. Avoid saving any changes.
4. Send failure alerts early if something is wrong.

What happens:

1. Cloud Scheduler calls Cloud Run `/orchestrate` with action `precheck`.
2. Cloud Run calls Apps Script `doPost` with action `precheck`.
3. Apps Script gets today’s active on call person.
4. Apps Script calls Cloud Run `/run` with `dryRun: true`.
5. Cloud Run performs a browser dry run and confirms it can reach the field.
6. Apps Script returns a structured success or failure response.
7. Cloud Run returns HTTP `200` or `500` to Scheduler.

### 2. Real execution at 07:30

Purpose:

Apply the real Rogers change.

What happens:

1. Cloud Scheduler calls Cloud Run `/orchestrate` with action `execute`.
2. Cloud Run calls Apps Script `executeOnCallUpdate`.
3. Apps Script finds today’s active on call person.
4. Apps Script writes the Automation tab.
5. Apps Script sends daily notification emails.
6. Apps Script calls Cloud Run `/run` with `dryRun: false`.
7. Cloud Run logs in to Rogers and saves the new value.
8. Apps Script stores execution success state.
9. Cloud Run returns `200` to Scheduler.

### 3. Retry 1 at 07:40

Purpose:

Recover from a failed execute run.

What happens:

1. Cloud Scheduler calls Cloud Run `/orchestrate` with action `retry1`.
2. Apps Script checks execution state.
3. If execute already succeeded, retry 1 returns a successful skip result.
4. If execute failed, retry 1 performs the same real update flow.

### 4. Retry 2 at 07:50

Purpose:

Second fallback if the first real attempt and retry 1 did not succeed.

What happens:

1. Cloud Scheduler calls Cloud Run `/orchestrate` with action `retry2`.
2. Apps Script checks execution state.
3. If execute already succeeded, retry 2 returns a successful skip result.
4. If execute failed, retry 2 performs the same real update flow.

## Safety rules built into the system

### 1. Only active users can be used

A calendar event is not enough by itself.

The system only proceeds when a matching person exists in `Directory` with:

```text
Active = YES
```

If no active person is found:

1. Rogers is not changed.
2. The action fails safely.
3. Admins and relevant users can be alerted.

### 2. Admins always receive important notifications

All users marked with:

```text
Admin = YES
```

receive the relevant alerts and daily confirmations.

### 3. Current and next on call people receive failure alerts

In failure scenarios, both the current person and the next person can be notified to reduce operational risk.

### 4. Retries do not have to change Rogers again if not needed

A successful retry action can be a valid skip response if the earlier execution already succeeded.

## Notifications

### Daily notification emails

Recipients:

1. Admins.
2. Current on call midwife.

Purpose:

1. Confirm who is on call.
2. Confirm the expected Hoteling Hours value.

### Failure alert emails

Recipients:

1. Admins.
2. Current on call midwife.
3. Next on call midwife, if available.

Purpose:

1. Warn that the system could not guarantee the update.
2. Include timestamp and retry number.
3. Provide enough information for manual intervention.

## Production deployment checklist

Use this section when setting up the production version in a new Google Workspace or Cloud project.

### Google Workspace side

1. Confirm the script owner account has access to the production calendar.
2. Confirm the script owner account has edit access to the production spreadsheet.
3. Confirm Apps Script authorization is allowed for that account.
4. Run a manual test function once to approve required permissions.

### Spreadsheet side

1. Create the production spreadsheet.
2. Create the `Directory` tab.
3. Create the `Automation` tab.
4. Copy the exact expected columns.
5. Fill real midwife data.
6. Mark active and admin flags carefully.

### Apps Script side

1. Paste the production Apps Script code.
2. Update production config values.
3. Save the project.
4. Run a manual test and approve permissions.
5. Deploy or update the web app.
6. Keep the same web app URL by editing the existing deployment and choosing a new version.

### Google Cloud side

1. Create or choose the production Cloud project.
2. Deploy Cloud Run.
3. Set environment variables:
   1. Rogers username.
   2. Rogers password.
4. Confirm `/run` works manually.
5. Confirm `/orchestrate` works manually.
6. Create the four Cloud Scheduler jobs.
7. Point Scheduler to Cloud Run `/orchestrate`, not directly to Apps Script.

## Manual testing checklist

Before trusting a production rollout, run this order.

### Cloud Run direct tests

1. Test `/run` with dry run.
2. Test `/run` with real update.
3. Test `/orchestrate` with `precheck`.
4. Test `/orchestrate` with `execute`.

### Scheduler tests

1. Force run `precheck`.
2. Force run `execute`.
3. Force run `retry1`.
4. Force run `retry2`.

### Business validation

1. Confirm the email was sent.
2. Confirm the Rogers value changed correctly.
3. Confirm retries skip or retry appropriately.

## Operational troubleshooting

### Symptom. Rogers value did not change

Check in this order:

1. Did the execute job run in Cloud Scheduler.
2. Did Cloud Run `/orchestrate` return `200`.
3. Did Apps Script execution succeed.
4. Did Cloud Run `/run` log a successful Rogers update.
5. Did the current on call person exist with `Active = YES`.
6. Did that person have a HotelingHours value.

### Symptom. Trigger is green but the business result was wrong

This is now less likely because Cloud Run returns a cleaner result, but still check:

1. Apps Script structured response.
2. Cloud Run logs for `/run`.
3. Spreadsheet values used for the person.
4. Calendar naming format.

### Symptom. Trigger runs but no one gets notified

Check:

1. Current on call person email exists.
2. Admin emails exist.
3. `Admin = YES` is set where needed.
4. Apps Script `MailApp` authorization exists.

### Symptom. Person in calendar is ignored

Likely causes:

1. Event name does not match the expected `NAME call` format.
2. Person is not marked `Active = YES`.
3. Person ID in the calendar does not match the `Directory` tab ID.

## Maintenance responsibilities

### Admin or coordinator

1. Maintain the Directory tab.
2. Keep active flags accurate.
3. Keep HotelingHours values accurate.
4. Maintain the on call calendar.

### System owner

1. Monitor production behavior.
2. Review failures and alerts.
3. Re run tests when needed.
4. Coordinate changes with the developer.

### Developer

1. Adjust Playwright selectors if the Rogers UI changes.
2. Refactor code when needed.
3. Improve monitoring and documentation.
4. Keep GitHub documentation current.

## Change management guidance

When making changes:

1. Test in a prototype or staging environment first.
2. Do not change schedule, spreadsheet structure, and Rogers selectors at the same time.
3. Make one controlled change at a time.
4. Force run precheck and execute after every significant deployment.

## Recommended GitHub repository structure

A clean repository layout could look like this:

```text
/
  cloud-run/
    Dockerfile
    package.json
    server.js
  apps-script/
    Code.gs
  docs/
    system-documentation.md
```

If you are not using `clasp` yet, store the Apps Script code in the repository anyway so GitHub remains the source of truth.

## Security notes

1. Never commit Rogers passwords into the repository.
2. Keep production secrets only in Cloud Run environment variables or a secret manager.
3. Limit who can change the production spreadsheet.
4. Limit who can deploy Cloud Run or edit Scheduler jobs.
5. Review email recipients before production rollout.

## Future enhancements

These are optional improvements for later.

### 1. Separate history spreadsheet

Purpose:

Store a compact audit trail without making the main operational spreadsheet heavier.

### 2. Stronger final failure escalation

If retry 2 also fails, send a stronger final alert with a very clear subject line.

### 3. Direct Google API integration from Cloud Run

Eventually, Apps Script can be reduced further or removed if Cloud Run takes over Calendar, Sheets, and email logic directly.

### 4. UI dashboard

A future admin interface could replace direct sheet editing for some users.

## Summary

This system is designed to be safe, observable, and operationally useful.

Its strengths are:

1. exact scheduling through Cloud Scheduler
2. reliable HTTP control through Cloud Run
3. business logic separation in Apps Script
4. retries and prechecks for resilience
5. alerts for operational safety
6. safeguards to prevent inactive users from being used

If maintained carefully, this system can reliably automate a critical daily operational workflow.
