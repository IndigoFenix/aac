# Improvements to the AAC system

## Calibration of eyegaze system
When starting to use the eyegaze selection (any integration tool), we need to calibrate it. This should use a standard 5-dots approach. We should save calibration data in aac settings and have a button on the settings page (in the AAC) to recalibrate when needed. Make sure not to select buttons while calibrating.

## Eyegaze system continuous reselection issue
When the user hovers over a button, if the button is replaced, it is treated as a new button, causing them to keep reselecting the new button. This needs to be fixed; button selection should disable the eyegaze selection until they reposition.

## Eyegaze system auto-detect confirmation
When an eyegaze system is auto-detected, show an indicator identifying the system so we know it's working.

## Yes/No selector fixes
The yes/no buttons should be larger, and when available, should blur the background so the user doesn't try to push other buttons.

## Reconnection on unsafe prompt error
When there is an unsafe prompt error, the system should wait a few seconds, then reconnect. Currently this isn't working.
This might have to do with connecting to the same session. Try to reconnect to the same session, and if it responds with unsafe prompt again, begin a new session. Show text indicating reconnection activity.