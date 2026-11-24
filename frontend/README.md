# Janus dashboard

Follow the [project setup](../docs/remaining_work.md#running-it) to configure the
admin account, register a device, and start the backend and simulator.
Open [Janus](http://127.0.0.1:8000/) and sign in. The dashboard keeps the
access token in the current tab for API requests and the live connection.

Select a device and metric to plot live readings. Under Past telemetry,
choose a time range and fields, then select Load readings.

Select **Show all charts** to plot every field. Drag a chart by its title to
reorder it, or focus the title and use the arrow keys. Drag its bottom-right
corner to resize it. Select a metric to return to its single chart.

Operators can send a command from its form and see the device acknowledgement.
Administrators can manage users, devices, permissions, and threshold rules
under Admin. Under Access, enter the account username and choose the device
in the toolbar before saving a role or revoking access.
