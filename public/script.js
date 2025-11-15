const scrapeBtn = document.getElementById("scrapeBtn");
const queryInput = document.getElementById("queryInput");
const responseLimit = document.getElementById("responseLimit");
const loading = document.getElementById("loading");
const resultSection = document.getElementById("resultSection");
const tableBody = document.querySelector("#resultTable tbody");

const exportBtn = document.getElementById("exportCSV");
const prevPageBtn = document.getElementById("prevPage");
const nextPageBtn = document.getElementById("nextPage");
const pageInfo = document.getElementById("pageInfo");

let scrapedData = [];
let currentPage = 1;
const rowsPerPage = 10;

async function scrape() {
    const query = queryInput.value.trim();
    if (!query) {
        alert("Enter a query first.");
        return;
    }

    loading.classList.remove("hidden");
    resultSection.classList.add("hidden");

    try {
        const res = await fetch(`/scrape?query=${encodeURIComponent(query)}&limit=${responseLimit}`);
        const data = await res.json();

        scrapedData = data.results || [];
        currentPage = 1;

        renderTable();
        resultSection.classList.remove("hidden");

    } catch (err) {
        alert("Error: " + err.message);
    }

    loading.classList.add("hidden");
}

function renderTable() {
    tableBody.innerHTML = "";

    const start = (currentPage - 1) * rowsPerPage;
    const end = start + rowsPerPage;
    const pageData = scrapedData.slice(start, end);

    pageData.forEach(item => {
        const row = document.createElement("tr");

        row.innerHTML = `
            <td>${item.name || ""}</td>
            <td>${item.address || ""}</td>
            <td>${item.phone || ""}</td>
            <td>${item.website || ""}</td>
            <td>${item.rating || ""}</td>
            <td>${item.reviews || ""}</td>
            <td><a href="${item.mapsUrl}" target="_blank">Open</a></td>
        `;

        tableBody.appendChild(row);
    });

    pageInfo.innerText = `Page ${currentPage} of ${Math.ceil(scrapedData.length / rowsPerPage)}`;
}

function exportCSV() {
    if (!scrapedData.length) return;

    let csv = "query,name,address,phone,website,rating,reviews,mapsUrl\n";

    scrapedData.forEach(d => {
        csv += [
            `"${d.query}"`,
            `"${d.name || ""}"`,
            `"${d.address || ""}"`,
            `"${d.phone || ""}"`,
            `"${d.website || ""}"`,
            `"${d.rating || ""}"`,
            `"${d.reviews || ""}"`,
            `"${d.mapsUrl || ""}"`
        ].join(",") + "\n";
    });

    const blob = new Blob([csv], { type: "text/csv" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "scraped_results.csv";
    link.click();
}

scrapeBtn.addEventListener("click", scrape);
exportBtn.addEventListener("click", exportCSV);

prevPageBtn.addEventListener("click", () => {
    if (currentPage > 1) {
        currentPage--;
        renderTable();
    }
});

nextPageBtn.addEventListener("click", () => {
    if (currentPage < scrapedData.length / rowsPerPage) {
        currentPage++;
        renderTable();
    }
});

responseLimit.addEventListener("change", () => {
    if (responseLimit.value < 1) responseLimit.value = 1;
    if (responseLimit.value > 100) responseLimit.value = 100;
});