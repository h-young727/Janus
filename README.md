# Janus

A telemetry and control platform for embedded systems.

## The Problem

An embedded system is built from many parts, such as a microcontroller plus the sensors, motors, and other components around it, each with its own inputs and outputs. To see what a system like this is doing, or to change its behavior, developers usually build a custom interface for each device, whether that is a serial monitor script, a one-off GUI, or hard-coded test routines.

That works while one person is sitting at a laptop plugged into the board, but it breaks down quickly.

- Every new device means another interface to build and maintain.
- There is no easy way to check on a device, or adjust it, once it is running unattended.
- Sharing a device is risky, because anyone who can watch it can usually control it too.
- Abnormal readings go unnoticed unless someone happens to be watching at the right moment.

## The Idea

Janus lets a device describe itself once. Its firmware sends readings (telemetry) and accepts commands (control) in a small JSON format, declared in a schema. From that schema alone, Janus stores the device's telemetry, shows it live and historically in a web dashboard, sends commands back to the device, flags abnormal readings with alerts, and controls who can view or command each device through roles.

Adding a new device means writing its firmware and its schema, not building a new interface.
