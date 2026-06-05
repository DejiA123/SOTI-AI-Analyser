var fso = new ActiveXObject("Scripting.FileSystemObject");
var f = fso.OpenTextFile("soti_pulse.html", 1);
var htmlContent = f.ReadAll();
f.Close();

var html = new ActiveXObject("htmlfile");
html.write(htmlContent);
html.close();

var items = html.querySelectorAll('.umb-block-grid__layout-item');
WScript.Echo("Layout items: " + items.length);

var tables = html.querySelectorAll('table');
WScript.Echo("Tables total: " + tables.length);

var blocks = 0;
for (var i = 0; i < items.length; i++) {
    var table = items[i].querySelector('table');
    if (table) {
        blocks++;
    }
}
WScript.Echo("Tables inside layout items: " + blocks);
