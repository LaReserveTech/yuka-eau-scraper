import Redis from 'ioredis';
import * as cheerio from 'cheerio';
import { Options } from 'selenium-webdriver/chrome';
import { Builder, Browser, By, WebDriver } from 'selenium-webdriver';
import { Controller, Get, Res } from '@nestjs/common';
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

  @Get()
  getHello(): string {
    return this.appService.getHello();
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
      'https://orobnat.sante.gouv.fr/orobnat/afficherPage.do?methode=menu&usd=AEP&idRegion=44',
    );

    const departements = await this.listDepartements(driver);

    await Promise.all(
      departements.map((departement: string) =>
        this.scrapeDepartement(departement),
      ),
    );

    // await driver.findElement(By.name('btnRechercher')).click();
    await driver.quit();
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
      'https://orobnat.sante.gouv.fr/orobnat/afficherPage.do?methode=menu&usd=AEP&idRegion=44',
    );

    await driver.findElement(By.name('departement')).click();
    await driver.findElement(By.css(`option[value='${departement}']`)).click();
    const communes = await this.listCommunes(driver);
    for (const commune of communes) {
      if (
        (await this.redis.hexists('yuka.communes-raw-table', commune)) === 1
      ) {
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
}
