(function(){const t=[{label:"Operations",links:[{href:"dashboard.html",label:"Dashboard"},{href:"meter-reading.html",label:"Meter Reading"},{href:"dsr.html",label:"DSR"}]},{label:"Finance",links:[{href:"credit.html",label:"Credit"},{href:"expenses.html",label:"Expenses"},{href:"day-closing.html",label:"Day closing & short"},{href:"billing.html",label:"Billing"}]},{label:"HR",links:[{href:"attendance.html",label:"Attendance"},{href:"salary.html",label:"Salary"},{href:"staff.html",label:"Staff"},{href:"invoices.html",label:"Vault"},{href:"letterhead.html",label:"Letter Desk"}]},{label:"Admin",adminOnly:!0,links:[{href:"analysis.html",label:"Analysis"},{href:"reports.html",label:"Reports"},{href:"settings.html",label:"Settings"}]}];function r(){return`${t.map(l=>{const s=l.adminOnly?' data-role="admin-only"':"",i=l.links.map(n=>`<a href="${n.href}">${n.label}</a>`).join(`
            `);return`        <div class="nav-group-block"${s}>
          <span class="nav-group-label" tabindex="0" aria-haspopup="true" aria-expanded="false">${l.label}<span class="nav-chevron" aria-hidden="true"></span></span>
          <div class="nav-group" role="menu">
            ${i}
          </div>
        </div>`}).join(`
`)}
        <button id="logout-button" class="link nav-logout">Logout</button>`}function a(){const e=document.querySelector("header.topbar [data-app-nav]");!e||e.querySelector(".nav-group-block")||(e.innerHTML=r())}document.readyState==="loading"?document.addEventListener("DOMContentLoaded",a):a()})();
