import Redis from 'ioredis';
import * as cheerio from 'cheerio';
import { Options } from 'selenium-webdriver/chrome';
import { Builder, Browser, By, WebDriver } from 'selenium-webdriver';
import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import { AppService } from './app.service';
import { Response } from 'express';

@Controller()
export class AppController {
  private readonly redis: Redis;

  constructor(private readonly appService: AppService) {
    this.redis = new Redis({
      port: 6380,
    });
  }

  @Post('/log')
  async log(@Body() body: string): Promise<void> {
    console.log(body);
  }

  @Get()
  async getHello(): Promise<any[]> {
    const records = await this.redis.hgetall('yuka.communes');
    return Object.keys(records).map((key) => JSON.parse(records[key]));
  }

  @Get('scrap')
  async scrap(@Res() res: Response) {
    res.status(204).send();

    const options = new Options();
    options.addArguments('headless');
    options.addArguments('disable-gpu');

    const driver = await new Builder()
      .forBrowser(Browser.CHROME)
      .setChromeOptions(options)
      .build();
    await driver.get(
      'https://orobnat.sante.gouv.fr/orobnat/afficherPage.do?methode=menu&usd=AEP&idRegion=24',
    );

    const departements = await this.listDepartements(driver);
    await driver.quit();

    await Promise.all(
      departements.map((departement: string) =>
        this.scrapeDepartement(departement),
      ),
    );
  }

  async scrapeDepartement(departement: string): Promise<void> {
    const options = new Options();
    options.addArguments('headless');
    options.addArguments('disable-gpu');

    const driver = await new Builder()
      .forBrowser(Browser.CHROME)
      .setChromeOptions(options)
      .build();
    await driver.get(
      'https://orobnat.sante.gouv.fr/orobnat/afficherPage.do?methode=menu&usd=AEP&idRegion=24',
    );

    await driver.findElement(By.name('departement')).click();
    await driver.findElement(By.css(`option[value='${departement}']`)).click();
    const communes = await this.listCommunes(driver);
    for (const commune of communes) {
      if (
        (await this.redis.hexists('yuka.communes-raw-table', commune)) === 1
      ) {
        console.log(`Skipping ${commune}`);
        continue;
      }

      try {
        await driver.findElement(By.name('communeDepartement')).click();
        await driver.findElement(By.css(`option[value='${commune}']`)).click();
        await driver.findElement(By.name('btnRechercher')).click();
        const tables = await driver.findElements(By.css('table'));
        await this.redis.hset(
          'yuka.communes-raw-table',
          commune,
          JSON.stringify({
            commune,
            generalInformations: await tables[0].getAttribute('innerHTML'),
            results: await tables[2].getAttribute('innerHTML'),
          }),
        );
        console.log(`Fetched ${commune}`);
      } catch (e) {
        console.log('damn, an error', { commune, e });
      }
    }

    await driver.quit();
  }

  async listCommunes(driver: WebDriver): Promise<string[]> {
    const selectHtml = await driver
      .findElement(By.name('communeDepartement'))
      .getAttribute('innerHTML');
    const $ = cheerio.load(selectHtml);
    const options = [];
    $('option').each(function () {
      options.push($(this).attr('value'));
    });
    return options;
  }

  async listDepartements(driver: WebDriver): Promise<string[]> {
    const selectHtml = await driver
      .findElement(By.name('departement'))
      .getAttribute('innerHTML');
    const $ = cheerio.load(selectHtml);
    const options = [];
    $('option').each(function () {
      options.push($(this).attr('value'));
    });
    return options;
  }

  @Get('compute')
  async compute() {
    const rawCommunes = await this.redis.hgetall('yuka.communes-raw-table');
    const communes = Object.keys(rawCommunes).forEach(
      async (key: string, i: number) => {
        if (await this.redis.hexists('yuka.communes', key)) {
          console.log(`skipp ${key}`);
          return;
        }
        console.log(i, key);
        const generalInformationsTable = cheerio.load(
          `<html><head></head><body><table>${
            JSON.parse(
              rawCommunes[key].replaceAll('\\\\t', '').replaceAll('\\\\n', ''),
            ).generalInformations
          }</table></body></html>`,
        );
        const dateDePrelevement =
          generalInformationsTable('tr:nth-child(1) td').text();
        const resultsTable = cheerio.load(
          `<html><head></head><body><table>${
            JSON.parse(
              rawCommunes[key].replaceAll('\\\\t', '').replaceAll('\\\\n', ''),
            ).results
          }</table></body></html>`,
        );

        const results = [];
        const resultsLength = resultsTable('tbody tr').length;
        for (let i = 0; i < resultsLength; i++) {
          results.push({
            key: resultsTable(
              `tbody tr:nth-child(${i + 1}) td:nth-child(1)`,
            ).text(),
            value: resultsTable(
              `tbody tr:nth-child(${i + 1}) td:nth-child(2)`,
            ).text(),
            maximum: resultsTable(
              `tbody tr:nth-child(${i + 1}) td:nth-child(3)`,
            ).text(),
          });
        }
        await this.redis.hset(
          'yuka.communes',
          key,
          JSON.stringify({
            commune: key,
            dateDePrelevement,
            results,
          }),
        );
      },
    );

    console.log(communes);
  }
}
