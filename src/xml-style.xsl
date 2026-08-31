<?xml version="1.0" encoding="utf-8"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform" xmlns:sitemap="http://www.sitemaps.org/schemas/sitemap/0.9">
  <xsl:output method="html" encoding="utf-8" indent="yes"/>
  <xsl:template match="/">
    <html lang="en">
      <head>
        <title>XML Feed</title>
        <style type="text/css">
          body { 
            font-family: "Atkinson Hyperlegible", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; 
            color: #000; 
            background: #fff; 
            max-width: 800px; 
            margin: 2rem auto; 
            padding: 0 1rem; 
            line-height: 1.6; 
          }
          h1 { border-bottom: 2px solid #000; padding-bottom: 0.5rem; font-size: 1.5rem; }
          .info { background: #f0f0f0; padding: 1rem; margin-bottom: 2rem; border: 1px solid #000; }
          .item { border-bottom: 1px solid #ccc; padding: 1rem 0; }
          .item:last-child { border-bottom: none; }
          .item a { color: #000; font-weight: bold; text-decoration: underline; }
          .item .date { font-size: 0.85rem; color: #666; }
          .item .description { margin-top: 0.5rem; }
          .sitemap-url { font-family: monospace; font-size: 0.9rem; }
          .footer { margin-top: 3rem; font-size: 0.8rem; text-align: center; border-top: 1px solid #000; padding-top: 1rem; }
        </style>
      </head>
      <body>
        <xsl:choose>
          <xsl:when test="rss">
            <h1><xsl:value-of select="rss/channel/title"/></h1>
            <div class="info">
              <p><xsl:value-of select="rss/channel/description"/></p>
              <p>This is an RSS feed. Subscribe to stay updated with the latest from the Lab.</p>
            </div>
            <xsl:for-each select="rss/channel/item">
              <div class="item">
                <a href="{link}"><xsl:value-of select="title"/></a>
                <div class="date"><xsl:value-of select="pubDate"/></div>
                <div class="description"><xsl:value-of select="description"/></div>
              </div>
            </xsl:for-each>
          </xsl:when>
          <xsl:when test="sitemap:urlset">
            <h1>XML Sitemap</h1>
            <div class="info">
              <p>A machine-readable list of all URLs on this site.</p>
            </div>
            <xsl:for-each select="sitemap:urlset/sitemap:url">
              <div class="item sitemap-url">
                <a href="{sitemap:loc}"><xsl:value-of select="sitemap:loc"/></a>
                <div class="date">Last Modified: <xsl:value-of select="sitemap:lastmod"/></div>
              </div>
            </xsl:for-each>
          </xsl:when>
        </xsl:choose>
        <div class="footer">
          Generated for A Quaint Laboratorium
        </div>
      </body>
    </html>
  </xsl:template>
</xsl:stylesheet>
